use crate::{
    cli::{UserSearchArgs, UsersArgs, UsersCommand},
    commands::{print_json, OutputMode},
};
use alv_core::{logs::CancellationToken, users::UserSearchParams};

pub fn run(args: UsersArgs, output: OutputMode) -> Result<i32, String> {
    match args.command {
        UsersCommand::Search(args) => run_search(args, output),
    }
}

fn run_search(args: UserSearchArgs, output: OutputMode) -> Result<i32, String> {
    let result = alv_core::users::search_users_with_cancel(
        &UserSearchParams {
            target_org: args.target_org,
            query: args.query,
            limit: args.limit,
        },
        &CancellationToken::new(),
    )?;
    if output.json {
        print_json(&result)?;
    } else {
        for user in &result.users {
            println!("{} {} {}", user.id, user.username, user.name);
        }
    }
    Ok(0)
}
