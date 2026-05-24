use crate::{
    cli::{ToolingArgs, ToolingCommand, ToolingRequestCommand},
    commands::{print_json, OutputMode},
};
use alv_core::logs::CancellationToken;

pub fn run(args: ToolingArgs, output: OutputMode) -> Result<i32, String> {
    match args.command {
        ToolingCommand::Query(args) => {
            let result = alv_core::tooling::query_tooling(
                args.target_org.as_deref(),
                &args.soql,
                &CancellationToken::new(),
            )?;
            if output.json {
                print_json(&result)?;
            } else {
                for record in &result.records {
                    println!(
                        "{}",
                        serde_json::to_string(record).map_err(|error| error.to_string())?
                    );
                }
            }
            Ok(0)
        }
        ToolingCommand::Request(args) => match args.command {
            ToolingRequestCommand::Get(args) => {
                let result = alv_core::tooling::request_get(
                    args.target_org.as_deref(),
                    &args.path_or_url,
                    &CancellationToken::new(),
                )?;
                if output.json {
                    print_json(&result)?;
                } else {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&result).map_err(|error| error.to_string())?
                    );
                }
                Ok(0)
            }
        },
    }
}
