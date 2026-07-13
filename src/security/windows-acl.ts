/** Windows ACL remediation facade backed by fs-safe defaults. */
export {
  createIcaclsResetCommand,
  formatIcaclsResetCommand,
  type PermissionExec as ExecFn,
} from "@openclaw/fs-safe/advanced";
import "../infra/fs-safe-defaults.js";
