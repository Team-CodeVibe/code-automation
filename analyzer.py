import ast
import sys
import json
import os
import openai
from openai import OpenAI
client = OpenAI()
from pinecone import Pinecone
import dotenv
import time
import traceback
from pathlib import Path

dotenv.load_dotenv()

# Set up OpenAI API key
openai.api_key = os.getenv("OPENAI_API_KEY")

# Initialize Pinecone
pc = Pinecone(api_key=os.getenv("PINECONE_API_KEY"))

# Create or connect to an index
index_name = 'code-embeddings'
index = pc.Index(index_name)

def get_embedding(text, max_retries=2, retry_delay=10):
    """Fetch embedding for the given text using OpenAI API."""
    for attempt in range(max_retries):
        try:
            # Updated API usage
            text = text.replace("\n", " ")
            return client.embeddings.create(input = [text], model="text-embedding-3-small").data[0].embedding
        except Exception as e:
            print(f"Unexpected error: {e}", file=sys.stderr)
            raise

class CodeAnalyzer(ast.NodeVisitor):
    """Analyzes Python code and generates embeddings for its elements."""
    def __init__(self):
        self.elements = []
        self.current_class = None

    def analyze_file(self, file_path):
        try:
            with open(file_path, 'r', encoding='utf-8') as file:
                source_code = file.read()
            tree = ast.parse(source_code)
            self.file_path = str(file_path)
            self.visit(tree)
        except Exception as e:
            print(f"Error analyzing file {file_path}: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)

    def visit_Module(self, node):
        docstring = ast.get_docstring(node)
        if docstring:
            self.process_element('module_docstring', docstring, node)
        self.generic_visit(node)

    def visit_ClassDef(self, node):
        class_name = node.name
        docstring = ast.get_docstring(node) or f"Class {class_name}"
        self.process_element('class', docstring, node, class_name)
        self.current_class = class_name
        self.generic_visit(node)
        self.current_class = None

    def visit_FunctionDef(self, node):
        func_name = node.name
        docstring = ast.get_docstring(node) or func_name
        full_name = f"{self.current_class}.{func_name}" if self.current_class else func_name
        self.process_element('function', docstring, node, full_name)
        self.generic_visit(node)

    def visit_Import(self, node):
        for alias in node.names:
            self.process_element('import', alias.name, node)

    def visit_ImportFrom(self, node):
        module = node.module or ''
        for alias in node.names:
            import_name = f"{module}.{alias.name}"
            self.process_element('import', import_name, node)

    def process_element(self, element_type, content, node, name=None):
        try:
            if not content or not isinstance(content, str):
                raise ValueError(f"Invalid content for {element_type} at line {getattr(node, 'lineno', 'unknown')}.")

            # Generate embedding using OpenAI API
            embedding = get_embedding(content)

            # Create unique ID
            element_id = f"{self.file_path}:{getattr(node, 'lineno', 'unknown')}:{element_type}:{name or ''}"
            
            # Ensure name is never null for metadata
            safe_name = name if name is not None else element_type
            
            # Metadata - ensure all fields have valid values
            metadata = {
                'type': element_type,
                'name': safe_name,
                'file_path': str(self.file_path),
                'line_number': str(getattr(node, 'lineno', 'unknown')),
                'content': content
            }

            # Upsert to Pinecone
            index.upsert(
                vectors=[{
                    "id": element_id,
                    "values": embedding,
                    "metadata": metadata
                }],
                namespace="code-analysis"  # Using a more specific namespace
            )

            # Store element info
            self.elements.append({
                'id': element_id,
                'type': element_type,
                'name': safe_name,
                'content': content,
                'file_path': str(self.file_path),
                'line_number': str(getattr(node, 'lineno', 'unknown'))
            })
        except Exception as e:
            print(f"Error processing element {name or element_type}: {str(e)}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)

def main():
    if len(sys.argv) != 2:
        print("Usage: python analyzer.py <directory_or_file_path>", file=sys.stderr)
        sys.exit(1)

    path_input = sys.argv[1]
    analyzer = CodeAnalyzer()

    # Check if the path is a directory or file
    path = Path(path_input)
    if path.is_file() and path.suffix == '.py':
        analyzer.analyze_file(path)
    elif path.is_dir():
        python_files = list(path.rglob('*.py'))
        print(f"Found {len(python_files)} Python files to analyze.", file=sys.stderr)
        for file_path in python_files:
            print(f"Analyzing file: {file_path}", file=sys.stderr)
            analyzer.analyze_file(file_path)
    else:
        print(f"The path {path_input} is neither a Python file nor a directory containing Python files.", file=sys.stderr)
        sys.exit(1)

    # Output the elements as JSON
    print(json.dumps(analyzer.elements, indent=2))

if __name__ == '__main__':
    main()
