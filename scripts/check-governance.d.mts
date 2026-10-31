// Type declarations for scripts/check-governance.mjs, used by tests/fitness/governance.spec.ts.
export interface Report {
  errors: string[];
  warnings: string[];
}

export interface Options {
  repoRoot: string;
  phase?: number;
  readBase?: (relPath: string) => string | null;
  strictBase?: boolean;
}

export declare const GOVERNANCE_CHECKS: readonly string[];
export declare function runChecks(opts: Options): Report;
export declare function gitBaseReader(repoRoot: string, ref: string): (rel: string) => string | null;
export declare function checkSharedKernelAllowlist(root: string, report: Report): void;
export declare function checkNoUtilityFolders(root: string, report: Report): void;
