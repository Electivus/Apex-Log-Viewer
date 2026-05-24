use crate::{
    cli::{OrgListArgs, OrgResolveArgs, OrgsArgs, OrgsCommand},
    commands::{print_json, OutputMode},
};

pub fn run(args: OrgsArgs, output: OutputMode) -> Result<i32, String> {
    match args.command {
        OrgsCommand::List(args) => run_list(args, output),
        OrgsCommand::Resolve(args) => run_resolve(args, output),
    }
}

fn run_list(args: OrgListArgs, output: OutputMode) -> Result<i32, String> {
    let orgs = alv_core::orgs::list_orgs(args.force_refresh)?;
    if output.json {
        print_json(&orgs)?;
    } else {
        for org in &orgs {
            let alias = org.alias.as_deref().unwrap_or("");
            println!("{} {}", org.username, alias);
        }
    }
    Ok(0)
}

fn run_resolve(args: OrgResolveArgs, output: OutputMode) -> Result<i32, String> {
    let result = alv_core::orgs::resolve_org(args.target_org.as_deref())?;
    if output.json {
        print_json(&result)?;
    } else {
        println!("{}", result.username);
    }
    Ok(0)
}
