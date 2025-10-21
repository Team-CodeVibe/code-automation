import ast
import sys
import json
import os
import time
import traceback
import re
import hashlib
from pathlib import Path
from openai import OpenAI
from pinecone import Pinecone, ServerlessSpec
import dotenv

dotenv.load_dotenv()

# Set up OpenAI and Pinecone clients
openai_api_key = os.getenv("OPENAI_API_KEY")
pinecone_api_key = os.getenv("PINECONE_API_KEY")
client = OpenAI(api_key=openai_api_key)
pc = Pinecone(api_key=pinecone_api_key)

# File patterns to ignore
IGNORE_PATTERNS = [
    '__pycache__',
    'node_modules',
    'venv',
    '.git',
    'test',
    '.vscode',
]

SUPPORTED_EXTENSIONS = {'.py'}


def should_analyze_file(file_path: str) -> bool:
    if any(pattern in str(file_path) for pattern in IGNORE_PATTERNS):
        return False
    return Path(file_path).suffix in SUPPORTED_EXTENSIONS


def get_project_hash(directory_path: str) -> str:
    abs_path = os.path.abspath(directory_path)
    path_hash = hashlib.md5(abs_path.encode()).hexdigest()[:8]
    return f"code-index-{path_hash}"


def ensure_index_exists(index_name: str, dimension: int = 256) -> None:
    try:
        active_indexes = [info['name'] for info in pc.list_indexes()]
        if index_name not in active_indexes:
            print(f"Creating new index: {index_name}", file=sys.stderr)
            pc.create_index(
                name=index_name,
                dimension=dimension,
                metric="cosine",
                spec=ServerlessSpec(cloud="aws", region="us-east-1")
            )
            time.sleep(2)
        else:
            print(f"Using existing index: {index_name}", file=sys.stderr)
    except Exception as e:
        print(f"Error ensuring index exists: {e}", file=sys.stderr)
        raise


def clean_and_truncate_text(text: str, max_length: int = 2000) -> str:
    # Remove unnecessary whitespace
    text = ' '.join(text.split())
    if len(text) > max_length:
        text = text[:max_length]
    return text.strip()


class CodeAnalyzer(ast.NodeVisitor):
    def __init__(self):
        self.elements = []
        self.current_class = None
        self.file_path = None
        self.pending = []
        self.batch_size = 20
        self.total_processed = 0
        self.start_time = time.time()
        self.index = None
        self.current_source = ''

    def visit_Module(self, node):
        docstring = ast.get_docstring(node)
        if docstring:
            self._add_element('module_docstring', docstring, node, None)
        self.generic_visit(node)

    def visit_ClassDef(self, node):
        source_snippet = ast.get_source_segment(self.current_source, node) or ''
        doc = ast.get_docstring(node) or ''
        content = f"""'''
{doc}
'''\n{source_snippet}"""
        name = node.name
        self._add_element('class', content, node, name)
        self.current_class = name
        self.generic_visit(node)
        self.current_class = None

    def visit_FunctionDef(self, node):
        source_snippet = ast.get_source_segment(self.current_source, node) or ''
        doc = ast.get_docstring(node) or ''
        content = f"""'''
{doc}
'''\n{source_snippet}"""
        full_name = f"{self.current_class}.{node.name}" if self.current_class else node.name
        # Debug: print function being processed
        print(f"Visiting function: {full_name} at {self.file_path}:{node.lineno}", file=sys.stderr)
        self._add_element('function', content, node, full_name)
        self.generic_visit(node)

    def visit_Import(self, node):
        for alias in node.names:
            self._add_element('import', alias.name, node, alias.name)

    def visit_ImportFrom(self, node):
        module = node.module or ''
        for alias in node.names:
            name = f"{module}.{alias.name}"
            self._add_element('import', name, node, name)

    def _add_element(self, element_type, content, node, name):
        if not content:
            return
        safe_name = name or element_type
        element = {
            'id': f"{self.file_path}:{getattr(node, 'lineno', 'unknown')}:{element_type}:{safe_name}",
            'content': content,
            'metadata': {
                'type': element_type,
                'name': safe_name,
                'file_path': str(self.file_path),
                'line_number': getattr(node, 'lineno', 'unknown'),
                'source': content
            }
        }
        self.pending.append(element)
        if len(self.pending) >= self.batch_size:
            self._process_batch()

    def _process_batch(self):
        if not self.pending:
            return
        try:
            texts = [clean_and_truncate_text(elem['content']) for elem in self.pending]
            emb_data = client.embeddings.create(
                input=texts,
                model="text-embedding-3-small",
                dimensions=256
            ).data
            vectors = []
            for elem, data in zip(self.pending, emb_data):
                vectors.append({
                    'id': elem['id'],
                    'values': data.embedding,
                    'metadata': elem['metadata']
                })
            if vectors:
                self.index.upsert(vectors=vectors)
            self.total_processed += len(vectors)
            elapsed = time.time() - self.start_time
            rate = self.total_processed / elapsed if elapsed > 0 else 0
            print(f"Processed {self.total_processed} elements ({rate:.2f}/sec)", file=sys.stderr)
            self.elements.extend(self.pending)
            self.pending = []
        except Exception as e:
            print(f"Error processing batch: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)

    def analyze_file(self, file_path):
        if not should_analyze_file(file_path):
            return
        try:
            self.file_path = str(file_path)
            with open(file_path, 'r', encoding='utf-8') as f:
                src = f.read()
            self.current_source = src
            # Debug: print full AST of the file
            tree = ast.parse(src)
            print(f"AST for {self.file_path}:\n{ast.dump(tree, include_attributes=True, indent=2)}", file=sys.stderr)
            self.visit(tree)
            if self.pending:
                self._process_batch()
        except Exception as e:
            print(f"Error analyzing {file_path}: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)


def main():
    if len(sys.argv) != 2:
        print("Usage: python analyzer.py <directory_or_file_path>", file=sys.stderr)
        sys.exit(1)

    input_path = Path(sys.argv[1])
    index_name = get_project_hash(str(input_path))
    ensure_index_exists(index_name)
    global pc
    analyzer = CodeAnalyzer()
    analyzer.index = pc.Index(index_name)

    if input_path.is_file():
        analyzer.analyze_file(input_path)
    elif input_path.is_dir():
        py_files = list(input_path.rglob("*.py"))
        for fp in py_files:
            analyzer.analyze_file(fp)
    else:
        print(f"Invalid path: {input_path}", file=sys.stderr)
        sys.exit(1)

    print(json.dumps(analyzer.elements))

if __name__ == '__main__':
    main()
