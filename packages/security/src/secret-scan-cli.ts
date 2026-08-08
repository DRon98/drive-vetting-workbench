import { resolve } from "node:path";
import { formatSecretScanReport, scanRepository } from "./secret-scan.js";

const root = resolve(process.argv[2] ?? process.cwd());
const findings = scanRepository(root);
console.log(formatSecretScanReport(findings));
if (findings.length > 0) process.exitCode = 1;
