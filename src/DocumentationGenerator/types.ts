export interface DocumentationSection {
    title: string;
    content: string;
    enabled: boolean;
}

export interface DocumentationOptions {
    sections: {
        architecture: boolean;
        api: boolean;
    };
    outputPath?: string;
}

export interface CodeExample {
    code: string;
    description: string;
    language: string;
}

export interface APIDocumentation {
    name: string;
    description: string;
    parameters: Parameter[];
    returnType: string;
    examples: CodeExample[];
}

export interface Parameter {
    name: string;
    type: string;
    description: string;
    required: boolean;
}

export interface MarkdownFormatter {
    formatSection(section: DocumentationSection): string;
    formatCodeExample(example: CodeExample): string;
    formatAPIDoc(api: APIDocumentation): string;
}
