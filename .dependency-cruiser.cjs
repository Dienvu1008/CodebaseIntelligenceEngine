// Architecture fitness rules (ARCHITECTURE_FITNESS §3–4). Every rule name starts with its FF ID, which
// governance/fitness.yaml references. tests/fitness/depcruise-rules.spec.ts proves that each rule fires on
// a deliberate violation fixture, so no rule is vacuous.
//
// Path regexes are written for two forms: modules resolved into node_modules and modules that cannot
// be resolved, which depcruise reports by bare name (e.g. 'vscode', which is never installed).

const UI_BUILD_DEPS = '(react|react-dom|vite|esbuild|markdown-it|dompurify)';
const npmPath = (name) => `(^|node_modules/)${name}($|/)`;

/** @type {import('dependency-cruiser').IConfiguration['forbidden']} */
const forbidden = [
  {
    name: 'FF-DEP-001-no-circular',
    comment: 'No circular dependencies at the module level.',
    severity: 'error',
    from: {},
    to: { circular: true },
  },
  {
    name: 'FF-DEP-002-core-is-pure',
    comment: 'packages/core imports nothing outside packages/core (no npm packages, including type-only imports).',
    severity: 'error',
    from: { path: '^packages/core/src/' },
    to: { pathNot: '^packages/core/src/' },
  },
  {
    name: 'FF-DEP-002b-core-protocol-no-node-builtins',
    comment: 'core and protocol never import Node built-ins (keeps the in-process option open, ADR-0002).',
    severity: 'error',
    from: { path: '^packages/(core|protocol)/src/' },
    to: { dependencyTypes: ['core'] },
  },
  {
    name: 'FF-DEP-003-vscode-only-in-extension-host',
    severity: 'error',
    from: { pathNot: '^packages/vscode-extension/src/host/' },
    to: { path: '^vscode$' },
  },
  {
    name: 'FF-DEP-004-no-codeforge',
    comment: 'CIE never depends on CodeForge (CODEFORGE_INTEGRATION CF-1).',
    severity: 'error',
    from: {},
    to: { path: '(@codeforge/|[Cc]ode[Ff]orge)' },
  },
  {
    name: 'FF-DEP-005-ui-build-deps-confined',
    severity: 'error',
    from: { pathNot: '^packages/vscode-extension/' },
    to: { path: npmPath(UI_BUILD_DEPS) },
  },
  {
    name: 'FF-DEP-006-protocol-is-leaf',
    severity: 'error',
    from: { path: '^packages/protocol/src/' },
    to: { pathNot: '^packages/protocol/src/' },
  },
  {
    name: 'FF-DEP-007-child-process-confined',
    severity: 'error',
    from: { pathNot: '^packages/(adapters/src/process|client/src)/' },
    to: { path: '^(node:)?child_process$' },
  },
  {
    name: 'FF-DEP-008-sqlite-confined',
    comment: 'Storage drivers only in adapters/sqlite. Phase 01 extends this into the full per-adapter allow-list.',
    severity: 'error',
    from: { pathNot: '^packages/adapters/(src|test)/sqlite/' },
    to: { path: `(${npmPath('(better-sqlite3|sql\\.js)')}|^node:sqlite$)` },
  },
  {
    name: 'FF-DEP-008b-treesitter-confined',
    comment: 'Tree-sitter runtime and grammars only in adapters/treesitter (ADR-0010).',
    severity: 'error',
    from: { pathNot: '^packages/adapters/(src|test)/treesitter/' },
    to: { path: npmPath('(web-tree-sitter|tree-sitter[^/]*)') },
  },
  {
    name: 'FF-DEP-008c-typescript-runtime-confined',
    comment: 'Runtime imports of the TypeScript compiler only in adapters/lang-ts (ADR-0016); type-only imports are allowed.',
    severity: 'error',
    from: { pathNot: '^packages/adapters/(src|test)/lang-ts/' },
    to: { path: npmPath('typescript'), dependencyTypesNot: ['type-only'] },
  },
  {
    name: 'FF-DEP-008d-llm-sdk-confined',
    comment: 'LLM SDKs only in adapters/llm-* (ADR-0009, SEC-003).',
    severity: 'error',
    from: { pathNot: '^packages/adapters/(src|test)/llm-[^/]+/' },
    to: { path: npmPath('(ollama|openai|@anthropic-ai/[^/]+|@google/generative-ai|langchain|@langchain/[^/]+)') },
  },
  {
    name: 'FF-DEP-008e-mcp-sdk-confined',
    comment: 'The MCP SDK only in packages/mcp (ADR-0003).',
    severity: 'error',
    from: { pathNot: '^packages/mcp/' },
    to: { path: npmPath('@modelcontextprotocol/[^/]+') },
  },
  {
    name: 'FF-BND-001-cross-context-via-public',
    comment: 'Inside core, another context may be imported only through its public.ts (DEPENDENCY_RULES C3).',
    severity: 'error',
    from: { path: '^packages/core/src/([^/]+)/' },
    to: {
      path: '^packages/core/src/[^/]+/',
      pathNot: [
        '^packages/core/src/$1/',
        '^packages/core/src/shared-kernel/',
        '^packages/core/src/[^/]+/public\\.ts$',
      ],
    },
  },
  {
    name: 'FF-BND-001b-shared-kernel-is-leaf',
    comment: 'shared-kernel imports nothing outside itself (DEPENDENCY_RULES C6).',
    severity: 'error',
    from: { path: '^packages/core/src/shared-kernel/' },
    to: { pathNot: '^packages/core/src/shared-kernel/' },
  },
  {
    name: 'FF-BND-002-domain-not-application',
    comment: 'A domain layer never imports an application layer (DEPENDENCY_RULES C4).',
    severity: 'error',
    from: { path: '^packages/core/src/[^/]+/domain/' },
    to: { path: '^packages/core/src/[^/]+/application/' },
  },
  {
    name: 'FF-BND-002b-no-domain-context-to-sync-or-query',
    comment: 'No domain context depends on synchronization or query (DEPENDENCY_RULES C5).',
    severity: 'error',
    from: { path: '^packages/core/src/(workspace|code-intelligence|knowledge|documentation)/' },
    to: { path: '^packages/core/src/(synchronization|query)/' },
  },
  // Acyclic context order: workspace <- code-intelligence <- knowledge <- documentation (C5). A context may
  // import the contexts before it, never the ones after it: one rule per source context.
  {
    name: 'FF-BND-002c-context-order',
    comment: 'workspace imports no later context (C5).',
    severity: 'error',
    from: { path: '^packages/core/src/workspace/' },
    to: { path: '^packages/core/src/(code-intelligence|knowledge|documentation)/' },
  },
  {
    name: 'FF-BND-002c-context-order-code-intelligence',
    comment: 'code-intelligence imports neither knowledge nor documentation (C5).',
    severity: 'error',
    from: { path: '^packages/core/src/code-intelligence/' },
    to: { path: '^packages/core/src/(knowledge|documentation)/' },
  },
  {
    name: 'FF-BND-002c-context-order-knowledge',
    comment: 'knowledge does not import documentation (C5).',
    severity: 'error',
    from: { path: '^packages/core/src/knowledge/' },
    to: { path: '^packages/core/src/documentation/' },
  },
  {
    name: 'FF-BND-002d-synchronization-not-to-query',
    severity: 'error',
    from: { path: '^packages/core/src/synchronization/' },
    to: { path: '^packages/core/src/query/' },
  },
  {
    name: 'FF-BND-005-llm-cannot-verify',
    comment: 'LLM adapters and inference intake cannot reach the verification capability (AI-002, C8).',
    severity: 'error',
    from: { path: '^packages/(adapters/src/llm-|core/src/knowledge/application/inference)' },
    to: { path: '^packages/core/src/knowledge/domain/verification/' },
  },
];

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden,
  options: {
    tsConfig: { fileName: 'tsconfig.base.json' },
    tsPreCompilationDeps: true,
    // Workspace packages resolve to their built dist/ entry (exports map), so `npm run build` must run
    // before depcruise. dist/ is a leaf: resolved, but not cruised further.
    doNotFollow: { path: ['node_modules', '(^|/)dist/'] },
    enhancedResolveOptions: {
      // Must be explicit: without it depcruise ignores package `exports` maps, and our packages have no `main`.
      exportsFields: ['exports'],
      conditionNames: ['import', 'types', 'node', 'default'],
      extensions: ['.ts', '.d.ts', '.js', '.mjs', '.cjs', '.json'],
    },
  },
};
