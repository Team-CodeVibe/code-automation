import {
    MarkdownFormatter,
    DocumentationSection,
    CodeExample,
    APIDocumentation,
} from "./types";

export class MarkdownDocumentationFormatter implements MarkdownFormatter {
    formatSection(section: DocumentationSection): string {
        if (!section.enabled) return "";
        return `## ${section.title}\n\n${section.content}\n\n`;
    }

    formatCodeExample(example: CodeExample): string {
        const codeBlock = `\`\`\`${example.language}\n${example.code}\n\`\`\``;
        return `### ${example.description}\n\n${codeBlock}\n\n`;
    }

    formatAPIDoc(api: APIDocumentation): string {
        let doc = `## ${api.name}\n\n${api.description}\n\n`;

        if (api.parameters.length > 0) {
            doc += "### Parameters\n\n";
            doc += "| Name | Type | Required | Description |\n";
            doc += "|------|------|----------|-------------|\n";
            api.parameters.forEach((param) => {
                doc += `| ${param.name} | \`${param.type}\` | ${
                    param.required ? "Yes" : "No"
                } | ${param.description} |\n`;
            });
            doc += "\n";
        }

        doc += `### Returns\n\n${api.returnType}\n\n`;

        if (api.examples.length > 0) {
            doc += "### Examples\n\n";
            api.examples.forEach((example) => {
                doc += this.formatCodeExample(example);
            });
        }

        return doc;
    }

    formatDocumentation(sections: DocumentationSection[]): string {
        let content = `# Project Documentation\n\n`;
        content += `*Auto-generated on ${new Date().toLocaleDateString()} at ${new Date().toLocaleTimeString()}*\n\n`;

        content += `## Table of Contents\n\n`;
        sections.forEach((section) => {
            if (section.enabled) {
                content += `- [${section.title}](#${section.title
                    .toLowerCase()
                    .replace(/\s+/g, "-")})\n`;
            }
        });
        content += `\n---\n\n`;

        content += sections
            .filter((section) => section.enabled)
            .map((section) => this.formatSection(section))
            .join("\n");

        return content;
    }
}
