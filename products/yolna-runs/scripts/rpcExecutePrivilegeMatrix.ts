// SOR-148 — local equivalent of the Supabase SECURITY DEFINER advisor lints.
//
// Run only against the disposable `yolna-runs` Docker database after a fresh
// local reset. It checks direct PostgreSQL privileges, including PUBLIC, so a
// REST rejection cannot mask an inherited execute grant.

import { execFileSync } from "node:child_process";
import { check, summarize, type CheckResult } from "./lib/check";

const container = "supabase_db_yolna-runs";
const applySignature = "public.apply_execution_work_correlation(uuid,uuid,text,text,text,text,text,uuid,real,uuid[],jsonb)";
const reclassifySignature = "public.reclassify_execution_work(uuid,uuid,uuid,uuid,text,text,text,jsonb)";

const query = `
  with target_functions as (
    select p.oid, p.proname, p.prosecdef, p.proconfig,
      coalesce(p.proacl, acldefault('f', p.proowner)) as acl
    from pg_proc p
    where p.oid in ('${applySignature}'::regprocedure, '${reclassifySignature}'::regprocedure)
  ), acl_entries as (
    select p.oid, p.proname, p.prosecdef, p.proconfig,
      case when acl.grantee = 0 then 'PUBLIC' else roles.rolname end as grantee,
      acl.privilege_type
    from target_functions p
    cross join lateral aclexplode(p.acl) acl
    left join pg_roles roles on roles.oid = acl.grantee
  )
  select p.proname,
    coalesce(bool_or(a.grantee = 'PUBLIC' and a.privilege_type = 'EXECUTE'), false) as public_execute,
    coalesce(bool_or(a.grantee = 'anon' and a.privilege_type = 'EXECUTE'), false) as anon_execute,
    coalesce(bool_or(a.grantee = 'authenticated' and a.privilege_type = 'EXECUTE'), false) as authenticated_execute,
    coalesce(bool_or(a.grantee = 'service_role' and a.privilege_type = 'EXECUTE'), false) as service_role_execute,
    p.prosecdef as security_definer,
    coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=public%' as search_path_public,
    (select count(*) from pg_proc overload where overload.proname = p.proname and overload.pronamespace = 'public'::regnamespace) = 1 as no_exposed_overload
  from target_functions p
  left join acl_entries a on a.oid = p.oid
  group by p.oid, p.proname, p.prosecdef, p.proconfig
  order by p.proname;
`;

export function run(): { pass: number; fail: number } {
  const output = execFileSync(
    "docker",
    ["exec", container, "psql", "-U", "postgres", "-d", "postgres", "-At", "-F", "|", "-c", query],
    { encoding: "utf8" }
  );
  const rows = output.trim().split(/\r?\n/u).filter(Boolean).map((line) => line.split("|"));
  const results: CheckResult[] = [];

  results.push(check("[Privilege matrix] both correlation RPC signatures exist", rows.length === 2));
  for (const row of rows) {
    const [name, publicExecute, anonExecute, authenticatedExecute, serviceRoleExecute, securityDefiner, searchPathPublic, noExposedOverload] = row;
    results.push(check(
      `[Privilege matrix] ${name}: PUBLIC/anon/authenticated=false; service_role=true`,
      publicExecute === "f" && anonExecute === "f" && authenticatedExecute === "f" && serviceRoleExecute === "t"
    ));
    results.push(check(`[Privilege matrix] ${name}: SECURITY DEFINER=true`, securityDefiner === "t"));
    results.push(check(`[Privilege matrix] ${name}: search_path=public`, searchPathPublic === "t"));
    results.push(check(`[Privilege matrix] ${name}: no unintended exposed overload`, noExposedOverload === "t"));
  }

  return summarize("Yolna Runs — SOR-148 correlation RPC privilege matrix", results);
}

try {
  const { fail } = run();
  if (fail > 0) process.exitCode = 1;
} catch (error) {
  console.error("[rpcExecutePrivilegeMatrix] FAILED WITH EXCEPTION", error);
  process.exitCode = 1;
}
