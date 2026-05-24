use crate::{
    cli::{
        DebugLevelDeleteArgs, DebugLevelGetArgs, DebugLevelListArgs, DebugLevelWriteArgs,
        DebugLevelsArgs, DebugLevelsCommand,
    },
    commands::{print_json, OutputMode},
};
use alv_core::{
    debug_levels::{
        DebugLevelDeleteParams, DebugLevelGetParams, DebugLevelListParams, DebugLevelRecord,
        DebugLevelWriteParams,
    },
    logs::CancellationToken,
};

pub fn run(args: DebugLevelsArgs, output: OutputMode) -> Result<i32, String> {
    match args.command {
        DebugLevelsCommand::List(args) => run_list(args, output),
        DebugLevelsCommand::Get(args) => run_get(args, output),
        DebugLevelsCommand::Create(args) => run_create(args, output),
        DebugLevelsCommand::Update(args) => run_update(args, output),
        DebugLevelsCommand::Delete(args) => run_delete(args, output),
    }
}

fn run_list(args: DebugLevelListArgs, output: OutputMode) -> Result<i32, String> {
    let result = alv_core::debug_levels::list_debug_levels(
        &DebugLevelListParams {
            target_org: args.target_org,
        },
        &CancellationToken::new(),
    )?;
    if output.json {
        print_json(&result)?;
    } else {
        for level in &result {
            println!(
                "{} {}",
                level.id.as_deref().unwrap_or(""),
                level.developer_name
            );
        }
    }
    Ok(0)
}

fn run_get(args: DebugLevelGetArgs, output: OutputMode) -> Result<i32, String> {
    let result = alv_core::debug_levels::get_debug_level(
        &DebugLevelGetParams {
            target_org: args.target_org,
            id: args.id,
            developer_name: args.developer_name,
        },
        &CancellationToken::new(),
    )?;
    if output.json {
        print_json(&result)?;
    } else if let Some(level) = result {
        println!(
            "{} {}",
            level.id.as_deref().unwrap_or(""),
            level.developer_name
        );
    } else {
        println!("debug level not found");
    }
    Ok(0)
}

fn run_create(args: DebugLevelWriteArgs, output: OutputMode) -> Result<i32, String> {
    let result = alv_core::debug_levels::create_debug_level(
        &DebugLevelWriteParams {
            target_org: args.target_org.clone(),
            id: args.id.clone(),
            record: record_from_args(&args),
            dry_run: args.dry_run,
            confirmed: args.yes,
        },
        &CancellationToken::new(),
    )?;
    print_write_result(&result, output, "Created", "create")
}

fn run_update(args: DebugLevelWriteArgs, output: OutputMode) -> Result<i32, String> {
    let result = alv_core::debug_levels::update_debug_level(
        &DebugLevelWriteParams {
            target_org: args.target_org.clone(),
            id: args.id.clone(),
            record: record_from_args(&args),
            dry_run: args.dry_run,
            confirmed: args.yes,
        },
        &CancellationToken::new(),
    )?;
    print_write_result(&result, output, "Updated", "update")
}

fn run_delete(args: DebugLevelDeleteArgs, output: OutputMode) -> Result<i32, String> {
    let result = alv_core::debug_levels::delete_debug_level(
        &DebugLevelDeleteParams {
            target_org: args.target_org,
            id: args.id,
            dry_run: args.dry_run,
            confirmed: args.yes,
        },
        &CancellationToken::new(),
    )?;
    print_write_result(&result, output, "Deleted", "delete")
}

fn print_write_result(
    result: &alv_core::debug_levels::DebugLevelWriteResult,
    output: OutputMode,
    success_verb: &str,
    action: &str,
) -> Result<i32, String> {
    if output.json {
        print_json(result)?;
    } else {
        let message = write_result_text(result, success_verb, action);
        if result.status == "error" {
            eprintln!("{message}");
        } else {
            println!("{message}");
        }
    }
    Ok(if result.status == "error" { 1 } else { 0 })
}

fn write_result_text(
    result: &alv_core::debug_levels::DebugLevelWriteResult,
    success_verb: &str,
    action: &str,
) -> String {
    if result.dry_run {
        "Would change debug level".to_string()
    } else if result.status == "error" {
        format!(
            "Failed to {action} debug level {}",
            result.id.as_deref().unwrap_or("")
        )
    } else {
        format!(
            "{success_verb} debug level {}",
            result.id.as_deref().unwrap_or("")
        )
    }
}

fn record_from_args(args: &DebugLevelWriteArgs) -> DebugLevelRecord {
    DebugLevelRecord {
        id: args.id.clone(),
        developer_name: args.developer_name.clone(),
        master_label: args
            .master_label
            .clone()
            .unwrap_or_else(|| args.developer_name.clone()),
        language: args.language.clone(),
        workflow: args.workflow.clone(),
        validation: args.validation.clone(),
        callout: args.callout.clone(),
        apex_code: args.apex_code.clone(),
        apex_profiling: args.apex_profiling.clone(),
        visualforce: args.visualforce.clone(),
        system: args.system.clone(),
        database: args.database.clone(),
        wave: args.wave.clone(),
        nba: args.nba.clone(),
        data_access: args.data_access.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::write_result_text;
    use alv_core::debug_levels::DebugLevelWriteResult;

    #[test]
    fn write_result_text_uses_failure_wording_for_error_status() {
        let result = DebugLevelWriteResult {
            status: "error".to_string(),
            dry_run: false,
            id: Some("7dl000000000001AAA".to_string()),
            record: None,
        };

        let message = write_result_text(&result, "Created", "create");

        assert_eq!(message, "Failed to create debug level 7dl000000000001AAA");
        assert!(!message.contains("Created"));
    }
}
