/**
 * CIE-owned extraction queries (ADR-0010 §5). Upstream `queries/tags.scm` files change between grammar
 * versions, so CIE keeps its own; golden tests pin their output.
 *
 * Capture conventions:
 *   @definition.<kind>  the declaration node; its range is the symbol range
 *   @name               the node holding the declared name (masked in bodyFingerprint)
 *   @import.<form>      an import site; @source is its specifier node
 * Kinds are refined in code where the grammar does not distinguish them (getters, constructors, constants,
 * Python methods). Module-level variables only: locals are not symbols.
 */

/** Definitions shared by the TypeScript and TSX grammars. */
export const TYPESCRIPT_DEFINITIONS = `
(class_declaration name: (_) @name) @definition.class
(abstract_class_declaration name: (_) @name) @definition.class
(interface_declaration name: (_) @name) @definition.interface
(type_alias_declaration name: (_) @name) @definition.type
(enum_declaration name: (_) @name) @definition.enum
(enum_body (property_identifier) @name @definition.enum_member)
(enum_body (enum_assignment name: (_) @name) @definition.enum_member)
(function_declaration name: (_) @name) @definition.function
(generator_function_declaration name: (_) @name) @definition.function
(function_signature name: (_) @name) @definition.function
(method_definition name: (_) @name) @definition.method
(method_signature name: (_) @name) @definition.method
(abstract_method_signature name: (_) @name) @definition.method
(public_field_definition name: (_) @name) @definition.property
(property_signature name: (_) @name) @definition.property
(internal_module name: (identifier) @name) @definition.namespace
(program (lexical_declaration (variable_declarator name: (identifier) @name) @definition.variable))
(program (variable_declaration (variable_declarator name: (identifier) @name) @definition.variable))
(program (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @name) @definition.variable)))
(program (export_statement declaration: (variable_declaration (variable_declarator name: (identifier) @name) @definition.variable)))
(program (export_statement "default" value: [(function_expression) (class) (arrow_function)] @definition.default))
`;

export const JAVASCRIPT_DEFINITIONS = `
(class_declaration name: (_) @name) @definition.class
(function_declaration name: (_) @name) @definition.function
(generator_function_declaration name: (_) @name) @definition.function
(method_definition name: (_) @name) @definition.method
(field_definition property: (_) @name) @definition.property
(program (lexical_declaration (variable_declarator name: (identifier) @name) @definition.variable))
(program (variable_declaration (variable_declarator name: (identifier) @name) @definition.variable))
(program (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @name) @definition.variable)))
(program (export_statement declaration: (variable_declaration (variable_declarator name: (identifier) @name) @definition.variable)))
(program (export_statement "default" value: [(function_expression) (class) (arrow_function)] @definition.default))
`;

/** Import sites for TS, TSX and JS. */
export const ECMASCRIPT_IMPORTS = `
(import_statement source: (string) @source) @import.static
(export_statement source: (string) @source) @import.reexport
(call_expression function: (import) arguments: (arguments . (_) @source)) @import.dynamic
(call_expression function: (identifier) @_req arguments: (arguments . (_) @source .) (#eq? @_req "require")) @import.require
`;

export const TYPESCRIPT_IMPORTS = `${ECMASCRIPT_IMPORTS}
(import_require_clause source: (string) @source) @import.require
`;

export const PYTHON_DEFINITIONS = `
(class_definition name: (identifier) @name) @definition.class
(function_definition name: (identifier) @name) @definition.function
(module (expression_statement (assignment left: (identifier) @name) @definition.variable))
(class_definition body: (block (expression_statement (assignment left: (identifier) @name) @definition.property)))
`;

export const PYTHON_IMPORTS = `
(import_statement) @import.static
(import_from_statement) @import.from
(call function: (attribute object: (identifier) @_m attribute: (identifier) @_f) arguments: (argument_list . (_) @source) (#eq? @_m "importlib") (#eq? @_f "import_module")) @import.dynamic
(call function: (identifier) @_f arguments: (argument_list . (_) @source) (#eq? @_f "__import__")) @import.dynamic
`;
