// FF-CPX-004: the shared kernel contains exactly the allow-listed files, and no package has a
// utils/helpers/common/misc folder (DEPENDENCY_RULES C6, C7).
import { describe, expect, it } from 'vitest';
import { checkNoUtilityFolders, checkSharedKernelAllowlist, type Report } from '../../scripts/check-governance.mjs';
import { REPO_ROOT } from '../helpers/repo.js';

describe('shared kernel and utility folders', () => {
  it('matches governance/shared-kernel.allowlist exactly', () => {
    const report: Report = { errors: [], warnings: [] };
    checkSharedKernelAllowlist(REPO_ROOT, report);
    expect(report.errors).toEqual([]);
  });

  it('has no utils/helpers/common/misc folders under packages/*/src', () => {
    const report: Report = { errors: [], warnings: [] };
    checkNoUtilityFolders(REPO_ROOT, report);
    expect(report.errors).toEqual([]);
  });
});
