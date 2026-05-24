use crate::{
    cli::DoctorArgs,
    commands::{print_json, OutputMode},
};

pub fn run(args: DoctorArgs, output: OutputMode) -> Result<i32, String> {
    let result =
        alv_core::doctor::run_doctor(args.target_org.as_deref(), env!("CARGO_PKG_VERSION"));
    if output.json {
        print_json(&result)?;
    } else {
        println!("Apex Log Viewer doctor");
        println!("Status: {}", result.status);
        println!("Runtime: {}", result.runtime_version);
        println!("Workspace: {}", result.workspace_root);
        println!("sf: {}", result.sf.message);
        println!("Cache: {}", result.cache_layout.message);
        println!("Writable apexlogs: {}", result.writable_apexlogs.message);
        if let Some(org_auth) = result.org_auth {
            println!("Org auth: {}", org_auth.message);
        }
    }
    Ok(if result.status == "ok" { 0 } else { 2 })
}
