/**
 * CIE-owned extraction queries (ADR-0010 §5). Upstream `queries/tags.scm` files change between grammar
 * versions, so CIE keeps its own; golden tests pin their output.
 *
 * Capture conventions:
 *   @definition.<kind>  the declaration node; its range is the symbol range
 *   @name               the node holding the declared name (masked in bodyFingerprint)
 *   @import.<form>      an import site; @source is its specifier node
 * Kinds are refined in code where the grammar does not distinguish them (getters, constructors, constants,
 * Python methods). Variables only at module level, in a `namespace` body or in `declare global`: locals are
 * not symbols. Methods only inside class bodies (and interface / type-literal-alias bodies): members of object
 * literals are values, not declarations (P02-13 review against the TypeScript compiler).
 * `@definition.parameter_property` captures every constructor parameter; the rules keep only those with an
 * accessibility modifier, `readonly` or `override` (TypeScript parameter properties), as class members.
 */

/**
 * Patterns anchored at the module level use the placeholder `@ROOT`. When error recovery fails at the top
 * level, tree-sitter returns an ERROR root instead of `program` / `module` whose children are still the
 * file's statements, so each pattern is emitted for both roots. A nested ERROR node also matches, but the
 * extractor drops declarations inside nested error regions (syntax.ts inErrorRegion).
 */
function rooted(patterns: string, roots: readonly string[]): string {
  return roots.map((r) => patterns.replaceAll('@ROOT', r)).join('\n');
}
const atModuleLevel = (patterns: string): string => rooted(patterns, ['program', 'ERROR']);

const ECMASCRIPT_MODULE_LEVEL = `
(@ROOT (lexical_declaration (variable_declarator name: (identifier) @name) @definition.variable))
(@ROOT (variable_declaration (variable_declarator name: (identifier) @name) @definition.variable))
(@ROOT (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @name) @definition.variable)))
(@ROOT (export_statement declaration: (variable_declaration (variable_declarator name: (identifier) @name) @definition.variable)))
(@ROOT (export_statement "default" value: [(function_expression) (class) (arrow_function)] @definition.default))
`;

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
(class_body (method_definition name: (_) @name) @definition.method)
(class_body (method_signature name: (_) @name) @definition.method)
(class_body (method_definition
  name: (property_identifier) @_ctor
  parameters: (formal_parameters [
    (required_parameter pattern: (identifier) @name)
    (optional_parameter pattern: (identifier) @name)
  ] @definition.parameter_property)
  (#eq? @_ctor "constructor")))
(interface_body (method_signature name: (_) @name) @definition.method)
(type_alias_declaration value: (object_type (method_signature name: (_) @name) @definition.method))
(abstract_method_signature name: (_) @name) @definition.method
(public_field_definition name: (_) @name) @definition.property
(interface_body (property_signature name: (_) @name) @definition.property)
(type_alias_declaration value: (object_type (property_signature name: (_) @name) @definition.property))
(internal_module name: (identifier) @name) @definition.namespace
(ambient_declaration "global" (statement_block)) @definition.global
${atModuleLevel(ECMASCRIPT_MODULE_LEVEL)}
${atModuleLevel(`
(@ROOT (ambient_declaration (lexical_declaration (variable_declarator name: (identifier) @name) @definition.variable)))
(@ROOT (ambient_declaration (variable_declaration (variable_declarator name: (identifier) @name) @definition.variable)))
(@ROOT (export_statement declaration: (ambient_declaration (lexical_declaration (variable_declarator name: (identifier) @name) @definition.variable))))
(@ROOT (export_statement declaration: (ambient_declaration (variable_declaration (variable_declarator name: (identifier) @name) @definition.variable))))
`)}
(internal_module body: (statement_block (lexical_declaration (variable_declarator name: (identifier) @name) @definition.variable)))
(internal_module body: (statement_block (variable_declaration (variable_declarator name: (identifier) @name) @definition.variable)))
(internal_module body: (statement_block (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @name) @definition.variable))))
(internal_module body: (statement_block (export_statement declaration: (variable_declaration (variable_declarator name: (identifier) @name) @definition.variable))))
(ambient_declaration "global" (statement_block (lexical_declaration (variable_declarator name: (identifier) @name) @definition.variable)))
(ambient_declaration "global" (statement_block (variable_declaration (variable_declarator name: (identifier) @name) @definition.variable)))
`;

export const JAVASCRIPT_DEFINITIONS = `
(class_declaration name: (_) @name) @definition.class
(function_declaration name: (_) @name) @definition.function
(generator_function_declaration name: (_) @name) @definition.function
(class_body (method_definition name: (_) @name) @definition.method)
(field_definition property: (_) @name) @definition.property
${atModuleLevel(ECMASCRIPT_MODULE_LEVEL)}
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
${rooted('(@ROOT (expression_statement (assignment left: (identifier) @name) @definition.variable))', ['module', 'ERROR'])}
(class_definition body: (block (expression_statement (assignment left: (identifier) @name) @definition.property)))
`;

export const PYTHON_IMPORTS = `
(import_statement) @import.static
(import_from_statement) @import.from
(call function: (attribute object: (identifier) @_m attribute: (identifier) @_f) arguments: (argument_list . (_) @source) (#eq? @_m "importlib") (#eq? @_f "import_module")) @import.dynamic
(call function: (identifier) @_f arguments: (argument_list . (_) @source) (#eq? @_f "__import__")) @import.dynamic
`;
