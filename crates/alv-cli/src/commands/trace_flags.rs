use crate::{
    cli::{
        TraceFlagApplyArgs, TraceFlagRemoveArgs, TraceFlagStatusArgs, TraceFlagTargetArgs,
        TraceFlagsArgs, TraceFlagsCommand,
    },
    commands::{print_json, OutputMode},
};
use alv_core::{
    logs::CancellationToken,
    trace_flags::{
        TraceFlagApplyParams, TraceFlagRemoveParams, TraceFlagStatusParams, TraceFlagTarget,
    },
};

pub fn run(args: TraceFlagsArgs, output: OutputMode) -> Result<i32, String> {
    match args.command {
        TraceFlagsCommand::Status(args) => run_status(args, output),
        TraceFlagsCommand::Apply(args) => run_apply(args, output),
        TraceFlagsCommand::Remove(args) => run_remove(args, output),
    }
}

fn run_status(args: TraceFlagStatusArgs, output: OutputMode) -> Result<i32, String> {
    let result = alv_core::trace_flags::status(
        &TraceFlagStatusParams {
            target_org: args.target_org,
            target: target_from_args(args.target)?,
        },
        &CancellationToken::new(),
    )?;
    if output.json {
        print_json(&result)?;
    } else {
        println!(
            "{}: {} ({}/{})",
            result.target_label,
            if result.is_active {
                "active"
            } else {
                "inactive"
            },
            result.active_target_count,
            result.resolved_target_count
        );
        if let Some(debug_level) = result.debug_level_name {
            println!("Debug level: {debug_level}");
        }
    }
    Ok(0)
}

fn run_apply(args: TraceFlagApplyArgs, output: OutputMode) -> Result<i32, String> {
    let result = alv_core::trace_flags::apply(
        &TraceFlagApplyParams {
            target_org: args.target_org,
            target: target_from_args(args.target)?,
            debug_level_name: args.debug_level_name,
            ttl_minutes: args.ttl_minutes,
            dry_run: args.dry_run,
            confirmed: args.yes,
        },
        &CancellationToken::new(),
    )?;
    if output.json {
        print_json(&result)?;
    } else if result.dry_run {
        println!(
            "Would apply trace flag to {} target(s)",
            result.resolved_target_count
        );
    } else {
        println!(
            "Applied trace flags: created {}, updated {}",
            result.created_count, result.updated_count
        );
    }
    Ok(0)
}

fn run_remove(args: TraceFlagRemoveArgs, output: OutputMode) -> Result<i32, String> {
    let result = alv_core::trace_flags::remove(
        &TraceFlagRemoveParams {
            target_org: args.target_org,
            target: target_from_args(args.target)?,
            dry_run: args.dry_run,
            confirmed: args.yes,
        },
        &CancellationToken::new(),
    )?;
    if output.json {
        print_json(&result)?;
    } else if result.dry_run {
        println!("Would remove {} trace flag(s)", result.trace_flag_ids.len());
    } else {
        println!("Removed {} trace flag(s)", result.removed_count);
    }
    Ok(0)
}

fn target_from_args(args: TraceFlagTargetArgs) -> Result<TraceFlagTarget, String> {
    if args.automated_process {
        return Ok(TraceFlagTarget::AutomatedProcess);
    }
    if args.platform_integration {
        return Ok(TraceFlagTarget::PlatformIntegration);
    }
    Ok(TraceFlagTarget::User {
        user_id: args.user_id.unwrap_or_default(),
    })
}
