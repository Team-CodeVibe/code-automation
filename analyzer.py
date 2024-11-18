import ast
import sys
import json
import os
import openai
from openai import OpenAI
client = OpenAI()
from pinecone import Pinecone, ServerlessSpec
import dotenv
import time
import traceback
from pathlib import Path
import re
import hashlib

dotenv.load_dotenv()

# Set up OpenAI API key
openai.api_key = os.getenv("OPENAI_API_KEY")

# Initialize Pinecone
pc = Pinecone(api_key=os.getenv("PINECONE_API_KEY"))

# Add file filtering
IGNORE_PATTERNS = [
    '__pycache__',
    'node_modules',
    'venv',
    '.git',
    'test',
    '.vscode',
]

def should_analyze_file(file_path: str) -> bool:
    """Check if file should be analyzed based on patterns and extensions."""
    # Skip ignored directories
    if any(pattern in str(file_path) for pattern in IGNORE_PATTERNS):
        return False
    
    # List of supported file extensions
    SUPPORTED_EXTENSIONS = {'.py'}
    
    return Path(file_path).suffix in SUPPORTED_EXTENSIONS

def get_project_hash(directory_path: str) -> str:
    """Generate a unique hash for the project based on its path and contents."""
    # Get the absolute path
    abs_path = os.path.abspath(directory_path)
    
    # Create a hash of the project path
    path_hash = hashlib.md5(abs_path.encode()).hexdigest()[:8]
    
    # Create index name with prefix for easy identification
    return f"code-index-{path_hash}"

def ensure_index_exists(index_name: str, dimension: int = 256) -> None:
    """Create index if it doesn't exist, otherwise connect to existing one."""
    try:
        # List all indexes
        active_indexes = [index_info['name'] for index_info in pc.list_indexes()]
        
        if index_name not in active_indexes:
            print(f"Creating new index: {index_name}", file=sys.stderr)
            pc.create_index(
                name=index_name,
                dimension=dimension,
                metric="cosine",
                spec=ServerlessSpec(
                    cloud="aws",
                    region="us-east-1"
                )
            )
            # Wait for index to be ready
            time.sleep(2)
        else:
            print(f"Using existing index: {index_name}", file=sys.stderr)
            
    except Exception as e:
        print(f"Error ensuring index exists: {e}", file=sys.stderr)
        raise

def get_embedding(text, max_retries=2, retry_delay=10):
    """Fetch embedding for the given text using OpenAI API."""
    # Truncate and clean text before embedding
    text = clean_and_truncate_text(text, max_length=500)  # Limit to 500 chars
    for attempt in range(max_retries):
        try:
            return client.embeddings.create(
                input=[text], 
                model="text-embedding-3-small",
                dimensions=256  # Use smaller dimensions for faster processing
            ).data[0].embedding
        except Exception as e:
            print(f"Unexpected error: {e}", file=sys.stderr)
            raise

def clean_and_truncate_text(text: str, max_length: int = 500) -> str:
    """Clean and truncate text while preserving important information."""
    # Remove unnecessary whitespace
    text = ' '.join(text.split())
    
    # Remove common boilerplate code patterns
    text = re.sub(r'import.*\n', '', text)
    text = re.sub(r'from.*import.*\n', '', text)
    
    # Remove comments that don't add value
    text = re.sub(r'#.*?\n', '\n', text)
    
    # Truncate if still too long, trying to break at meaningful points
    if len(text) > max_length:
        # Try to find a good breaking point
        break_point = text.rfind('.', 0, max_length)
        if break_point == -1:
            break_point = text.rfind(' ', 0, max_length)
        if break_point == -1:
            break_point = max_length
            
        text = text[:break_point]
    
    return text.strip()

class CodeAnalyzer(ast.NodeVisitor):
    """Analyzes Python code and generates embeddings for its elements."""
    def __init__(self):
        self.elements = []
        self.current_class = None
        self.batch_size = 20  # Process embeddings in batches
        self.pending_elements = []
        self.total_processed = 0
        self.start_time = time.time()

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
            self.process_element('import', alias.name, node, alias.name)

    def visit_ImportFrom(self, node):
        module = node.module or ''
        for alias in node.names:
            import_name = f"{module}.{alias.name}"
            self.process_element('import', import_name, node, import_name)

    def process_element(self, element_type, content, node, name=None):
        try:
            if not content or not isinstance(content, str):
                return

            # Ensure name is never null for metadata
            safe_name = name if name is not None else element_type
            
            # Create element data
            element_data = {
                'id': f"{self.file_path}:{getattr(node, 'lineno', 'unknown')}:{element_type}:{safe_name}",
                'content': content,
                'metadata': {
                    'type': element_type,
                    'name': safe_name,
                    'file_path': str(self.file_path),
                    'line_number': str(getattr(node, 'lineno', 'unknown')),
                    'content': content
                }
            }
            
            self.pending_elements.append(element_data)
            
            # Process batch if we've accumulated enough elements
            if len(self.pending_elements) >= self.batch_size:
                self.process_batch()
                
        except Exception as e:
            print(f"Error processing element {name or element_type}: {str(e)}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)

    def process_batch(self):
        """Process a batch of elements together."""
        if not self.pending_elements:
            return
            
        try:
            # Generate embeddings for all contents in batch
            contents = [clean_and_truncate_text(elem['content']) for elem in self.pending_elements]
            embeddings = client.embeddings.create(
                input=contents,
                model="text-embedding-3-small",
                dimensions=256
            ).data
            
            # Prepare vectors for batch upsert
            vectors = []
            for elem, embedding_data in zip(self.pending_elements, embeddings):
                vectors.append({
                    "id": elem['id'],
                    "values": embedding_data.embedding,
                    "metadata": elem['metadata']
                })
            
            # Batch upsert to Pinecone
            if vectors:
                index.upsert(vectors=vectors)
            
            # Update progress
            self.total_processed += len(vectors)
            elapsed_time = time.time() - self.start_time
            rate = self.total_processed / elapsed_time
            print(f"Processed {self.total_processed} elements ({rate:.2f} elements/sec)", file=sys.stderr)
            
            # Store elements info
            self.elements.extend(self.pending_elements)
            
            # Clear pending elements
            self.pending_elements = []
            
        except Exception as e:
            print(f"Error processing batch: {str(e)}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)

    def analyze_file(self, file_path):
        if not should_analyze_file(file_path):
            return
            
        try:
            with open(file_path, 'r', encoding='utf-8') as file:
                source_code = file.read()
            tree = ast.parse(source_code)
            self.file_path = str(file_path)
            self.visit(tree)
            
            # Process any remaining elements
            if self.pending_elements:
                self.process_batch()
                
        except Exception as e:
            print(f"Error analyzing file {file_path}: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)

def main():
    if len(sys.argv) != 2:
        print("Usage: python analyzer.py <directory_or_file_path>", file=sys.stderr)
        sys.exit(1)

    path_input = sys.argv[1]
    
    # Generate index name based on project
    index_name = get_project_hash(path_input)
    
    # Ensure index exists
    ensure_index_exists(index_name)
    
    # Get the index
    global index
    index = pc.Index(index_name)
    
    analyzer = CodeAnalyzer()
    
    # Check if the path is a directory or file
    path = Path(path_input)
    if path.is_file():
        if should_analyze_file(path):
            analyzer.analyze_file(path)
    elif path.is_dir():
        # Find all supported files
        all_files = []
        for ext in ['.py']:
            all_files.extend(path.rglob(f'*{ext}'))
        
        print(f"Found {len(all_files)} files to analyze.", file=sys.stderr)
        for file_path in all_files:
            if should_analyze_file(file_path):
                print(f"Analyzing file: {file_path}", file=sys.stderr)
                analyzer.analyze_file(file_path)
    else:
        print(f"The path {path_input} is not a valid file or directory.", file=sys.stderr)
        sys.exit(1)

    # Output the elements as JSON
    print(json.dumps(analyzer.elements, indent=2))

if __name__ == '__main__':
    main()
