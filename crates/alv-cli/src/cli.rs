use clap::{Args, Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(
    name = "apex-log-viewer",
    version,
    about = "Local-first Apex log sync and analysis CLI"
)]
pub struct Cli {
    #[arg(long, global = true)]
    pub json: bool,
    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    #[command(name = "app-server")]
    AppServer(AppServerArgs),
    Doctor(DoctorArgs),
    Orgs(OrgsArgs),
    Logs(LogsArgs),
    Users(UsersArgs),
    #[command(name = "trace-flags")]
    TraceFlags(TraceFlagsArgs),
    #[command(name = "debug-levels")]
    DebugLevels(DebugLevelsArgs),
    Tooling(ToolingArgs),
    Skills(SkillsArgs),
}

#[derive(Debug, Args)]
pub struct AppServerArgs {
    #[arg(long)]
    pub stdio: bool,
}

#[derive(Debug, Args)]
pub struct DoctorArgs {
    #[arg(long = "target-org")]
    pub target_org: Option<String>,
}

#[derive(Debug, Args)]
pub struct OrgsArgs {
    #[command(subcommand)]
    pub command: OrgsCommand,
}

#[derive(Debug, Subcommand)]
pub enum OrgsCommand {
    List(OrgListArgs),
    Resolve(OrgResolveArgs),
}

#[derive(Debug, Args)]
pub struct OrgListArgs {
    #[arg(long)]
    pub force_refresh: bool,
}

#[derive(Debug, Args)]
pub struct OrgResolveArgs {
    #[arg(long = "target-org")]
    pub target_org: Option<String>,
}

#[derive(Debug, Args)]
pub struct LogsArgs {
    #[command(subcommand)]
    pub command: LogsCommand,
}

#[derive(Debug, Subcommand)]
pub enum LogsCommand {
    List(LogListArgs),
    Sync(LogSyncArgs),
    Status(LogStatusArgs),
    Search(LogSearchArgs),
    Read(LogReadArgs),
    Resolve(LogResolveArgs),
    Triage(LogTriageArgs),
    Delete(LogDeleteArgs),
}

#[derive(Debug, Args)]
pub struct LogListArgs {
    #[arg(long = "target-org")]
    pub target_org: Option<String>,
    #[arg(long)]
    pub limit: Option<usize>,
    #[arg(long)]
    pub offset: Option<usize>,
}

#[derive(Debug, Args)]
pub struct LogSyncArgs {
    #[arg(long = "target-org")]
    pub target_org: Option<String>,
    #[arg(long)]
    pub force_full: bool,
    #[arg(long)]
    pub concurrency: Option<usize>,
}

#[derive(Debug, Args)]
pub struct LogStatusArgs {
    #[arg(long = "target-org")]
    pub target_org: Option<String>,
}

#[derive(Debug, Args)]
pub struct LogSearchArgs {
    pub query: String,
    #[arg(long = "target-org")]
    pub target_org: Option<String>,
}

#[derive(Debug, Args)]
pub struct LogReadArgs {
    pub log_id: String,
    #[arg(long = "target-org")]
    pub target_org: Option<String>,
    #[arg(long = "max-bytes")]
    pub max_bytes: Option<usize>,
}

#[derive(Debug, Args)]
pub struct LogResolveArgs {
    pub log_id: String,
    #[arg(long = "target-org")]
    pub target_org: Option<String>,
}

#[derive(Debug, Args)]
pub struct LogTriageArgs {
    pub log_ids: Vec<String>,
    #[arg(long = "target-org")]
    pub target_org: Option<String>,
}

#[derive(Debug, Args)]
pub struct LogDeleteArgs {
    #[arg(long = "target-org")]
    pub target_org: Option<String>,
    #[arg(long, value_parser = ["mine", "all"])]
    pub scope: Option<String>,
    #[arg(long = "ids", value_delimiter = ',')]
    pub ids: Vec<String>,
    #[arg(long = "ids-file")]
    pub ids_file: Option<String>,
    #[arg(long)]
    pub limit: Option<usize>,
    #[arg(long)]
    pub dry_run: bool,
    #[arg(long)]
    pub yes: bool,
}

#[derive(Debug, Args)]
pub struct UsersArgs {
    #[command(subcommand)]
    pub command: UsersCommand,
}

#[derive(Debug, Subcommand)]
pub enum UsersCommand {
    Search(UserSearchArgs),
}

#[derive(Debug, Args)]
pub struct UserSearchArgs {
    pub query: Option<String>,
    #[arg(long = "target-org")]
    pub target_org: Option<String>,
    #[arg(long)]
    pub limit: Option<usize>,
}

#[derive(Debug, Args)]
pub struct TraceFlagsArgs {
    #[command(subcommand)]
    pub command: TraceFlagsCommand,
}

#[derive(Debug, Subcommand)]
pub enum TraceFlagsCommand {
    Status(TraceFlagStatusArgs),
    Apply(TraceFlagApplyArgs),
    Remove(TraceFlagRemoveArgs),
}

#[derive(Debug, Args)]
pub struct TraceFlagTargetArgs {
    #[arg(long = "user-id", conflicts_with_all = ["current_user", "automated_process", "platform_integration"])]
    pub user_id: Option<String>,
    #[arg(long = "current-user", conflicts_with_all = ["user_id", "automated_process", "platform_integration"])]
    pub current_user: bool,
    #[arg(long = "automated-process", conflicts_with_all = ["user_id", "current_user", "platform_integration"])]
    pub automated_process: bool,
    #[arg(long = "platform-integration", conflicts_with_all = ["user_id", "current_user", "automated_process"])]
    pub platform_integration: bool,
}

#[derive(Debug, Args)]
pub struct TraceFlagStatusArgs {
    #[arg(long = "target-org")]
    pub target_org: Option<String>,
    #[command(flatten)]
    pub target: TraceFlagTargetArgs,
}

#[derive(Debug, Args)]
pub struct TraceFlagApplyArgs {
    #[arg(long = "target-org")]
    pub target_org: Option<String>,
    #[command(flatten)]
    pub target: TraceFlagTargetArgs,
    #[arg(long = "debug-level")]
    pub debug_level_name: String,
    #[arg(long = "ttl-minutes")]
    pub ttl_minutes: Option<u64>,
    #[arg(long)]
    pub dry_run: bool,
    #[arg(long)]
    pub yes: bool,
}

#[derive(Debug, Args)]
pub struct TraceFlagRemoveArgs {
    #[arg(long = "target-org")]
    pub target_org: Option<String>,
    #[command(flatten)]
    pub target: TraceFlagTargetArgs,
    #[arg(long)]
    pub dry_run: bool,
    #[arg(long)]
    pub yes: bool,
}

#[derive(Debug, Args)]
pub struct DebugLevelsArgs {
    #[command(subcommand)]
    pub command: DebugLevelsCommand,
}

#[derive(Debug, Subcommand)]
pub enum DebugLevelsCommand {
    List(DebugLevelListArgs),
    Get(DebugLevelGetArgs),
    Create(DebugLevelWriteArgs),
    Update(DebugLevelWriteArgs),
    Delete(DebugLevelDeleteArgs),
}

#[derive(Debug, Args)]
pub struct DebugLevelListArgs {
    #[arg(long = "target-org")]
    pub target_org: Option<String>,
}

#[derive(Debug, Args)]
pub struct DebugLevelGetArgs {
    #[arg(long = "target-org")]
    pub target_org: Option<String>,
    #[arg(long)]
    pub id: Option<String>,
    #[arg(long = "developer-name")]
    pub developer_name: Option<String>,
}

#[derive(Debug, Args)]
pub struct DebugLevelWriteArgs {
    #[arg(long = "target-org")]
    pub target_org: Option<String>,
    #[arg(long)]
    pub id: Option<String>,
    #[arg(long = "developer-name")]
    pub developer_name: String,
    #[arg(long = "master-label")]
    pub master_label: Option<String>,
    #[arg(long, default_value = "None")]
    pub language: String,
    #[arg(long, default_value = "INFO")]
    pub workflow: String,
    #[arg(long, default_value = "INFO")]
    pub validation: String,
    #[arg(long, default_value = "INFO")]
    pub callout: String,
    #[arg(long = "apex-code", default_value = "DEBUG")]
    pub apex_code: String,
    #[arg(long = "apex-profiling", default_value = "INFO")]
    pub apex_profiling: String,
    #[arg(long, default_value = "INFO")]
    pub visualforce: String,
    #[arg(long, default_value = "DEBUG")]
    pub system: String,
    #[arg(long, default_value = "INFO")]
    pub database: String,
    #[arg(long, default_value = "INFO")]
    pub wave: String,
    #[arg(long, default_value = "INFO")]
    pub nba: String,
    #[arg(long = "data-access", default_value = "INFO")]
    pub data_access: String,
    #[arg(long)]
    pub dry_run: bool,
    #[arg(long)]
    pub yes: bool,
}

#[derive(Debug, Args)]
pub struct DebugLevelDeleteArgs {
    #[arg(long = "target-org")]
    pub target_org: Option<String>,
    #[arg(long)]
    pub id: String,
    #[arg(long)]
    pub dry_run: bool,
    #[arg(long)]
    pub yes: bool,
}

#[derive(Debug, Args)]
pub struct ToolingArgs {
    #[command(subcommand)]
    pub command: ToolingCommand,
}

#[derive(Debug, Subcommand)]
pub enum ToolingCommand {
    Query(ToolingQueryArgs),
    Request(ToolingRequestArgs),
}

#[derive(Debug, Args)]
pub struct ToolingQueryArgs {
    pub soql: String,
    #[arg(long = "target-org")]
    pub target_org: Option<String>,
}

#[derive(Debug, Args)]
pub struct ToolingRequestArgs {
    #[command(subcommand)]
    pub command: ToolingRequestCommand,
}

#[derive(Debug, Subcommand)]
pub enum ToolingRequestCommand {
    Get(ToolingRequestGetArgs),
}

#[derive(Debug, Args)]
pub struct ToolingRequestGetArgs {
    pub path_or_url: String,
    #[arg(long = "target-org")]
    pub target_org: Option<String>,
}

#[derive(Debug, Args)]
pub struct SkillsArgs {
    #[command(subcommand)]
    pub command: SkillsCommand,
}

#[derive(Debug, Subcommand)]
pub enum SkillsCommand {
    Install(SkillInstallArgs),
}

#[derive(Debug, Args)]
pub struct SkillInstallArgs {
    #[arg(long = "codex-home")]
    pub codex_home: Option<String>,
    #[arg(long)]
    pub force: bool,
    #[arg(long)]
    pub dry_run: bool,
}
