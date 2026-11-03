/**
 * Python free-name uses (Phase 03, P03-08): the syntax half of L2 references and calls. A resolver
 * (lang-python) binds the names; this module only decides which identifiers are *uses of a free name*.
 *
 * Function scopes follow Python's rules closely enough for a deterministic heuristic:
 *  - a function (or lambda, or comprehension) binds its parameters and every name assigned in its body
 *    (assignment and augmented-assignment targets, `for` targets, `with … as`, `except … as`, walrus,
 *    local imports, nested `def` / `class`), wherever the binding appears in the body;
 *  - `global x` makes `x` refer to the module scope; `nonlocal x` keeps it local to an enclosing function;
 *  - a use of a name bound by an enclosing function scope is local and not reported;
 *  - default values, annotations, decorators and base classes are evaluated in the enclosing scope;
 *  - class bodies are not scopes for the functions inside them (as in Python); names bound directly in a
 *    class body are declarations and are not reported.
 * Not reported: declaration names, attribute names (`x.y` reports `x` only), keyword-argument names, import
 * statements, `global` / `nonlocal` statements.
 */
import type { Node } from 'web-tree-sitter';
import type { RawOccurrence } from './rules.js';

interface Scope {
  readonly names: Set<string>;
  readonly globals: Set<string>;
}

interface Use {
  readonly node: Node;
  readonly chain: readonly Scope[];
}

const PATTERNS = new Set(['pattern_list', 'tuple_pattern', 'list_pattern', 'tuple', 'list', 'parenthesized_expression', 'list_splat_pattern', 'list_splat']);
const COMPREHENSIONS = new Set(['list_comprehension', 'set_comprehension', 'dictionary_comprehension', 'generator_expression']);

class Collector {
  readonly uses: Use[] = [];

  /** Records the names bound by an assignment-like target; reads inside it (`a.b`, `a[i]`) are uses. */
  private bindTarget(node: Node, chain: readonly Scope[]): void {
    if (node.type === 'identifier') {
      chain.at(-1)?.names.add(node.text);
      return;
    }
    if (PATTERNS.has(node.type)) {
      for (const c of node.namedChildren) this.bindTarget(c, chain);
      return;
    }
    this.visit(node, chain); // attribute or subscript target: its object is read
  }

  /** Visits the given fields of `node` (when present) in `chain`. */
  private fields(node: Node, names: readonly string[], chain: readonly Scope[]): void {
    for (const f of names) {
      const n = node.childForFieldName(f);
      if (n !== null) this.visit(n, chain);
    }
  }

  /**
   * One parameter: its names are bound in the function scope; its annotation and default value are
   * evaluated in the enclosing scope (`outer`). Separators (`/`, `*`) bind nothing.
   */
  private parameter(p: Node, outer: readonly Scope[], scope: Scope): void {
    if (p.type === 'identifier') {
      scope.names.add(p.text);
    } else if (p.type === 'default_parameter' || p.type === 'typed_default_parameter') {
      const name = p.childForFieldName('name');
      if (name !== null) scope.names.add(name.text);
      this.fields(p, ['type', 'value'], outer);
    } else if (p.type === 'typed_parameter') {
      for (const c of p.namedChildren) if (c.type !== 'type') this.parameter(c, outer, scope);
      this.fields(p, ['type'], outer);
    } else if (p.type === 'list_splat_pattern' || p.type === 'dictionary_splat_pattern') {
      this.splat(p, scope);
    }
  }

  private parameters(params: Node | null, outer: readonly Scope[], scope: Scope): void {
    for (const p of params?.namedChildren ?? []) this.parameter(p, outer, scope);
  }

  private splat(node: Node, scope: Scope): void {
    for (const c of node.namedChildren) if (c.type === 'identifier') scope.names.add(c.text);
  }

  private func(node: Node, chain: readonly Scope[]): void {
    const name = node.childForFieldName('name');
    if (name !== null) chain.at(-1)?.names.add(name.text);
    const scope: Scope = { names: new Set(), globals: new Set() };
    this.parameters(node.childForFieldName('parameters'), chain, scope);
    const returnType = node.childForFieldName('return_type');
    if (returnType !== null) this.visit(returnType, chain);
    const body = node.childForFieldName('body');
    if (body !== null) this.visit(body, [...chain, scope]);
  }

  private lambda(node: Node, chain: readonly Scope[]): void {
    const scope: Scope = { names: new Set(), globals: new Set() };
    this.parameters(node.childForFieldName('parameters'), chain, scope);
    const body = node.childForFieldName('body');
    if (body !== null) this.visit(body, [...chain, scope]);
  }

  private cls(node: Node, chain: readonly Scope[]): void {
    const name = node.childForFieldName('name');
    if (name !== null) chain.at(-1)?.names.add(name.text);
    const supers = node.childForFieldName('superclasses');
    if (supers !== null) this.visit(supers, chain);
    const body = node.childForFieldName('body');
    // The class body runs in the enclosing chain; names it binds are class attributes (declarations).
    if (body !== null) this.classBody(body, chain);
  }

  private classBody(body: Node, chain: readonly Scope[]): void {
    for (const stmt of body.namedChildren) {
      const assignment = stmt.type === 'expression_statement' ? stmt.namedChildren[0] : undefined;
      if (assignment !== undefined && assignment.type === 'assignment') {
        const left = assignment.childForFieldName('left');
        if (left !== null && left.type !== 'identifier') this.bindTarget(left, []);
        for (const field of ['right', 'type']) {
          const n = assignment.childForFieldName(field);
          if (n !== null) this.visit(n, chain);
        }
        continue;
      }
      this.visit(stmt, chain);
    }
  }

  private comprehension(node: Node, chain: readonly Scope[]): void {
    const scope: Scope = { names: new Set(), globals: new Set() };
    const inner = [...chain, scope];
    for (const c of node.namedChildren) {
      if (c.type === 'for_in_clause') {
        const left = c.childForFieldName('left');
        if (left !== null) this.bindTarget(left, inner);
        const right = c.childForFieldName('right');
        if (right !== null) this.visit(right, inner);
      } else this.visit(c, inner);
    }
  }

  private importNames(node: Node, chain: readonly Scope[]): void {
    const scope = chain.at(-1);
    if (scope === undefined) return; // module-level imports are bound by the resolver's import map
    for (const c of node.namedChildren) {
      if (c.type === 'aliased_import') {
        const alias = c.childForFieldName('alias');
        if (alias !== null) scope.names.add(alias.text);
      } else if (c.type === 'dotted_name' && c.id !== node.childForFieldName('module_name')?.id) {
        const first = c.namedChildren[0];
        if (first !== undefined) scope.names.add(node.type === 'import_statement' ? first.text : (c.namedChildren.at(-1)?.text ?? first.text));
      }
    }
  }

  private assignment(node: Node, chain: readonly Scope[]): void {
    const left = node.childForFieldName('left');
    // A module-level `name = …` is a declaration (an extracted symbol), neither a use nor a local.
    if (left !== null && !(chain.length === 0 && left.type === 'identifier')) this.bindTarget(left, chain);
    this.fields(node, ['right', 'type'], chain);
  }

  private forStatement(node: Node, chain: readonly Scope[]): void {
    const left = node.childForFieldName('left');
    if (left !== null) this.bindTarget(left, chain);
    for (const c of node.namedChildren) if (c.id !== left?.id) this.visit(c, chain);
  }

  /** `with x as y`, `except E as e`: the alias binds, the rest is read. */
  private asPattern(node: Node, chain: readonly Scope[]): void {
    const alias = node.childForFieldName('alias');
    for (const c of node.namedChildren) {
      if (c.id !== alias?.id) this.visit(c, chain);
      else for (const t of c.namedChildren.length > 0 ? c.namedChildren : [c]) this.bindTarget(t, chain);
    }
  }

  private namedExpression(node: Node, chain: readonly Scope[]): void {
    const name = node.childForFieldName('name');
    if (name !== null) chain.at(-1)?.names.add(name.text);
    this.fields(node, ['value'], chain);
  }

  private declare(node: Node, chain: readonly Scope[], set: 'globals' | 'names'): void {
    for (const c of node.namedChildren) if (c.type === 'identifier') chain.at(-1)?.[set].add(c.text);
  }

  /** Node types with their own rule; every other node visits its named children. */
  private readonly handlers: Readonly<Record<string, (node: Node, chain: readonly Scope[]) => void>> = {
    identifier: (node, chain) => this.uses.push({ node, chain }),
    function_definition: (node, chain) => this.func(node, chain),
    lambda: (node, chain) => this.lambda(node, chain),
    class_definition: (node, chain) => this.cls(node, chain),
    assignment: (node, chain) => this.assignment(node, chain),
    augmented_assignment: (node, chain) => this.assignment(node, chain),
    for_statement: (node, chain) => this.forStatement(node, chain),
    as_pattern: (node, chain) => this.asPattern(node, chain),
    named_expression: (node, chain) => this.namedExpression(node, chain),
    global_statement: (node, chain) => this.declare(node, chain, 'globals'),
    nonlocal_statement: (node, chain) => this.declare(node, chain, 'names'),
    import_statement: (node, chain) => this.importNames(node, chain),
    import_from_statement: (node, chain) => this.importNames(node, chain),
    future_import_statement: (node, chain) => this.importNames(node, chain),
    keyword_argument: (node, chain) => this.fields(node, ['value'], chain),
    attribute: (node, chain) => this.fields(node, ['object'], chain),
  };

  visit(node: Node, chain: readonly Scope[]): void {
    const handler = this.handlers[node.type];
    if (handler !== undefined) handler(node, chain);
    else if (COMPREHENSIONS.has(node.type)) this.comprehension(node, chain);
    else for (const c of node.namedChildren) this.visit(c, chain);
  }
}

/** True when `name` is bound locally somewhere in the chain (innermost first; `global` stops at the module). */
function isLocal(name: string, chain: readonly Scope[]): boolean {
  for (let i = chain.length - 1; i >= 0; i--) {
    const s = chain[i] as Scope;
    if (s.globals.has(name)) return false;
    if (s.names.has(name)) return true;
  }
  return false;
}

const isCallee = (n: Node): boolean => n.parent?.type === 'call' && n.parent.childForFieldName('function')?.id === n.id;

export function pythonOccurrences(root: Node): RawOccurrence[] {
  const collector = new Collector();
  collector.visit(root, []);
  // Scopes are complete only after the walk: a name assigned later in a function is still local to it.
  return collector.uses
    .filter((u) => !isLocal(u.node.text, u.chain))
    .map((u) => ({ node: u.node, call: isCallee(u.node) }))
    .sort((a, b) => a.node.startIndex - b.node.startIndex);
}
