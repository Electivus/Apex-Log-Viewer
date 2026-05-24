use alv_core::{
    debug_levels::{
        DebugLevelDeleteParams, DebugLevelGetParams, DebugLevelListParams, DebugLevelWriteParams,
    },
    log_ops::{DeleteLogsParams, ReadLogParams, ResolveLogPathParams},
    logs::{CancellationToken, LogsCursor, LogsListParams, LogsRuntimeError},
    logs_sync::LogsSyncParams,
    orgs,
    search::SearchQueryParams,
    tooling,
    trace_flags::{TraceFlagApplyParams, TraceFlagRemoveParams, TraceFlagStatusParams},
    triage::LogsTriageParams,
    users::UserSearchParams,
};
use alv_protocol::messages::{InitializeParams, InitializeResult, RuntimeCapabilities};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap},
    fmt::Write as _,
    io::{self, BufRead, Write},
    sync::mpsc::{self, RecvTimeoutError},
    thread,
    time::Duration,
};
use tokio::sync::mpsc::{error::TryRecvError, Receiver};

use crate::transport_stdio::bounded_transport_channel;

#[path = "handlers/logs.rs"]
mod logs_handler;
#[path = "handlers/orgs.rs"]
mod orgs_handler;

const WORKER_POLL_INTERVAL: Duration = Duration::from_millis(10);
const JSONRPC_SERVER_ERROR: i32 = -32000;
pub const CLI_VERSION_ENV: &str = "ALV_CLI_VERSION";

#[derive(Debug, Clone)]
struct ServerError {
    message: String,
    data_json: Option<String>,
}

impl ServerError {
    fn message(&self) -> &str {
        &self.message
    }

    fn data_json(&self) -> Option<&str> {
        self.data_json.as_deref()
    }

    fn into_message(self) -> String {
        self.message
    }
}

impl From<String> for ServerError {
    fn from(message: String) -> Self {
        Self {
            message,
            data_json: None,
        }
    }
}

impl From<LogsRuntimeError> for ServerError {
    fn from(error: LogsRuntimeError) -> Self {
        let data_json = error
            .data()
            .and_then(|data| serde_json::to_string(data).ok());
        Self {
            message: error.message().to_string(),
            data_json,
        }
    }
}

enum ParsedRequest {
    Cancel { request_id: String },
    Call(ServerCall),
}

struct ServerCall {
    id: String,
    operation: ServerOperation,
}

enum ServerOperation {
    Initialize(InitializeParams),
    Doctor {
        target_org: Option<String>,
    },
    OrgList {
        force_refresh: bool,
    },
    OrgAuth {
        username: Option<String>,
    },
    OrgResolve {
        target_org: Option<String>,
    },
    LogsList(LogsListParams),
    LogsSync(LogsSyncParams),
    LogsRead(ReadLogParams),
    LogsDelete(DeleteLogsParams),
    SearchQuery(SearchQueryParams),
    LogsTriage(LogsTriageParams),
    ResolveCachedPath(logs_handler::ResolveCachedLogPathParams),
    ResolveLogPath(ResolveLogPathParams),
    UsersSearch(UserSearchParams),
    TraceFlagStatus(TraceFlagStatusParams),
    TraceFlagApply(TraceFlagApplyParams),
    TraceFlagRemove(TraceFlagRemoveParams),
    DebugLevelList(DebugLevelListParams),
    DebugLevelGet(DebugLevelGetParams),
    DebugLevelCreate(DebugLevelWriteParams),
    DebugLevelUpdate(DebugLevelWriteParams),
    DebugLevelDelete(DebugLevelDeleteParams),
    ToolingQuery {
        target_org: Option<String>,
        soql: String,
    },
    ToolingRequestGet {
        target_org: Option<String>,
        path: String,
    },
    Unknown(String),
}

struct WorkerCompletion {
    request_id: String,
    response: Option<String>,
}

fn release_channel_for_version(version: &str) -> &'static str {
    if version.contains('-') {
        "pre-release"
    } else {
        "stable"
    }
}

pub fn handle_initialize(_params: InitializeParams) -> InitializeResult {
    let cli_version = std::env::var(CLI_VERSION_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
    let channel = release_channel_for_version(&cli_version).to_string();

    InitializeResult {
        runtime_version: cli_version.clone(),
        cli_version,
        protocol_version: "1".to_string(),
        channel,
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        capabilities: RuntimeCapabilities {
            orgs: true,
            logs: true,
            search: true,
            tail: true,
            debug_flags: true,
            doctor: true,
        },
        state_dir: ".alv/state".to_string(),
        cache_dir: ".alv/cache".to_string(),
    }
}

pub fn run_stdio() -> Result<(), String> {
    let (sender, receiver) = bounded_transport_channel::<String>();

    thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else {
                break;
            };
            if line.trim().is_empty() {
                continue;
            }
            if sender.blocking_send(line).is_err() {
                break;
            }
        }
    });

    let stdout = io::BufWriter::new(io::stdout().lock());
    run_event_loop(receiver, stdout)
}

pub fn run_event_loop<W: Write>(
    mut receiver: Receiver<String>,
    mut writer: W,
) -> Result<(), String> {
    let (worker_sender, worker_receiver) = mpsc::channel::<WorkerCompletion>();
    let mut active_requests = HashMap::<String, CancellationToken>::new();
    let mut input_closed = false;

    loop {
        while let Ok(completion) = worker_receiver.try_recv() {
            finish_request(&mut writer, &mut active_requests, completion)?;
        }

        if input_closed {
            if active_requests.is_empty() {
                break;
            }

            let completion = worker_receiver
                .recv()
                .map_err(|_| "request worker channel closed unexpectedly".to_string())?;
            finish_request(&mut writer, &mut active_requests, completion)?;
            continue;
        }

        match receiver.try_recv() {
            Ok(line) => {
                dispatch_request_line(&line, &worker_sender, &mut active_requests)?;
            }
            Err(TryRecvError::Empty) => match worker_receiver.recv_timeout(WORKER_POLL_INTERVAL) {
                Ok(completion) => finish_request(&mut writer, &mut active_requests, completion)?,
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => {
                    if active_requests.is_empty() {
                        break;
                    }
                    return Err("request worker channel closed unexpectedly".to_string());
                }
            },
            Err(TryRecvError::Disconnected) => {
                input_closed = true;
            }
        }
    }

    Ok(())
}

pub fn handle_request_line(request: &str) -> Result<Option<String>, String> {
    match parse_request_line(request)? {
        ParsedRequest::Cancel { .. } => Ok(None),
        ParsedRequest::Call(call) => {
            let cancellation = CancellationToken::new();
            execute_call(call, &cancellation)
                .map(Some)
                .map_err(ServerError::into_message)
        }
    }
}

fn dispatch_request_line(
    request: &str,
    worker_sender: &mpsc::Sender<WorkerCompletion>,
    active_requests: &mut HashMap<String, CancellationToken>,
) -> Result<(), String> {
    match parse_request_line(request)? {
        ParsedRequest::Cancel { request_id } => {
            if let Some(token) = active_requests.get(request_id.trim()) {
                token.cancel();
            }
        }
        ParsedRequest::Call(call) => {
            spawn_request_worker(call, worker_sender.clone(), active_requests);
        }
    }

    Ok(())
}

fn spawn_request_worker(
    call: ServerCall,
    worker_sender: mpsc::Sender<WorkerCompletion>,
    active_requests: &mut HashMap<String, CancellationToken>,
) {
    let request_id = call.id.clone();
    let cancellation = CancellationToken::new();
    active_requests.insert(request_id.clone(), cancellation.clone());

    thread::spawn(move || {
        let response = match execute_call(call, &cancellation) {
            Ok(response) if !cancellation.is_cancelled() => Some(response),
            Ok(_) => None,
            Err(error) if cancellation.is_cancelled() || is_cancelled_error(error.message()) => {
                None
            }
            Err(error) => Some(jsonrpc_error(
                &request_id,
                JSONRPC_SERVER_ERROR,
                error.message(),
                error.data_json(),
            )),
        };

        let _ = worker_sender.send(WorkerCompletion {
            request_id,
            response,
        });
    });
}

fn finish_request<W: Write>(
    writer: &mut W,
    active_requests: &mut HashMap<String, CancellationToken>,
    completion: WorkerCompletion,
) -> Result<(), String> {
    active_requests.remove(&completion.request_id);

    if let Some(response) = completion.response {
        writer
            .write_all(response.as_bytes())
            .map_err(|error| error.to_string())?;
        writer.write_all(b"\n").map_err(|error| error.to_string())?;
        writer.flush().map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn execute_call(call: ServerCall, cancellation: &CancellationToken) -> Result<String, ServerError> {
    match call.operation {
        ServerOperation::Initialize(params) => {
            let result = handle_initialize(params);
            Ok(jsonrpc_result(
                &call.id,
                &serialize_initialize_result(&result),
            ))
        }
        ServerOperation::Doctor { target_org } => {
            let version = std::env::var(CLI_VERSION_ENV)
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
            let payload = serialize_result(&alv_core::doctor::run_doctor(
                target_org.as_deref(),
                &version,
            ))?;
            Ok(jsonrpc_result(&call.id, &payload))
        }
        ServerOperation::OrgList { force_refresh } => {
            let payload = orgs_handler::handle_org_list(force_refresh)?;
            Ok(jsonrpc_result(&call.id, &payload))
        }
        ServerOperation::OrgAuth { username } => {
            let payload = orgs_handler::handle_org_auth(username.as_deref())?;
            Ok(jsonrpc_result(&call.id, &payload))
        }
        ServerOperation::OrgResolve { target_org } => {
            let payload = serialize_result(&orgs::resolve_org(target_org.as_deref())?)?;
            Ok(jsonrpc_result(&call.id, &payload))
        }
        ServerOperation::LogsList(params) => {
            let payload = logs_handler::handle_logs_list_with_cancel(params, cancellation)?;
            Ok(jsonrpc_result(&call.id, &payload))
        }
        ServerOperation::LogsSync(params) => {
            let payload = logs_handler::handle_logs_sync_with_cancel(params, cancellation)?;
            Ok(jsonrpc_result(&call.id, &payload))
        }
        ServerOperation::LogsRead(params) => {
            let payload = serialize_result(&alv_core::log_ops::read_log_with_cancel(
                &params,
                cancellation,
            )?)?;
            Ok(jsonrpc_result(&call.id, &payload))
        }
        ServerOperation::LogsDelete(params) => {
            let payload = serialize_result(&alv_core::log_ops::delete_logs_with_cancel(
                &params,
                cancellation,
            )?)?;
            Ok(jsonrpc_result(&call.id, &payload))
        }
        ServerOperation::SearchQuery(params) => {
            let payload = logs_handler::handle_search_query_with_cancel(params, cancellation)?;
            Ok(jsonrpc_result(&call.id, &payload))
        }
        ServerOperation::LogsTriage(params) => {
            let payload = logs_handler::handle_logs_triage_with_cancel(params, cancellation)?;
            Ok(jsonrpc_result(&call.id, &payload))
        }
        ServerOperation::ResolveCachedPath(params) => {
            let payload = logs_handler::handle_resolve_cached_path(params)?;
            Ok(jsonrpc_result(&call.id, &payload))
        }
        ServerOperation::ResolveLogPath(params) => {
            let payload = serialize_result(&alv_core::log_ops::resolve_log_path(&params))?;
            Ok(jsonrpc_result(&call.id, &payload))
        }
        ServerOperation::UsersSearch(params) => {
            let payload = serialize_result(&alv_core::users::search_users_with_cancel(
                &params,
                cancellation,
            )?)?;
            Ok(jsonrpc_result(&call.id, &payload))
        }
        ServerOperation::TraceFlagStatus(params) => {
            let payload = serialize_result(&alv_core::trace_flags::status(&params, cancellation)?)?;
            Ok(jsonrpc_result(&call.id, &payload))
        }
        ServerOperation::TraceFlagApply(params) => {
            let payload = serialize_result(&alv_core::trace_flags::apply(&params, cancellation)?)?;
            Ok(jsonrpc_result(&call.id, &payload))
        }
        ServerOperation::TraceFlagRemove(params) => {
            let payload = serialize_result(&alv_core::trace_flags::remove(&params, cancellation)?)?;
            Ok(jsonrpc_result(&call.id, &payload))
        }
        ServerOperation::DebugLevelList(params) => {
            let payload = serialize_result(&alv_core::debug_levels::list_debug_levels(
                &params,
                cancellation,
            )?)?;
            Ok(jsonrpc_result(&call.id, &payload))
        }
        ServerOperation::DebugLevelGet(params) => {
            let payload = serialize_result(&alv_core::debug_levels::get_debug_level(
                &params,
                cancellation,
            )?)?;
            Ok(jsonrpc_result(&call.id, &payload))
        }
        ServerOperation::DebugLevelCreate(params) => {
            let payload = serialize_result(&alv_core::debug_levels::create_debug_level(
                &params,
                cancellation,
            )?)?;
            Ok(jsonrpc_result(&call.id, &payload))
        }
        ServerOperation::DebugLevelUpdate(params) => {
            let payload = serialize_result(&alv_core::debug_levels::update_debug_level(
                &params,
                cancellation,
            )?)?;
            Ok(jsonrpc_result(&call.id, &payload))
        }
        ServerOperation::DebugLevelDelete(params) => {
            let payload = serialize_result(&alv_core::debug_levels::delete_debug_level(
                &params,
                cancellation,
            )?)?;
            Ok(jsonrpc_result(&call.id, &payload))
        }
        ServerOperation::ToolingQuery { target_org, soql } => {
            let payload = serialize_result(&tooling::query_tooling(
                target_org.as_deref(),
                &soql,
                cancellation,
            )?)?;
            Ok(jsonrpc_result(&call.id, &payload))
        }
        ServerOperation::ToolingRequestGet { target_org, path } => {
            let payload = serialize_result(&tooling::request_get(
                target_org.as_deref(),
                &path,
                cancellation,
            )?)?;
            Ok(jsonrpc_result(&call.id, &payload))
        }
        ServerOperation::Unknown(method) => Ok(jsonrpc_error(
            &call.id,
            -32601,
            &format!("method not found: {method}"),
            None,
        )),
    }
}

fn parse_request_line(request: &str) -> Result<ParsedRequest, String> {
    let envelope: Value =
        serde_json::from_str(request).map_err(|error| format!("invalid request JSON: {error}"))?;

    let method = envelope
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing method".to_string())?;
    let params = envelope.get("params").cloned().unwrap_or(Value::Null);

    if method == "cancel" {
        return Ok(ParsedRequest::Cancel {
            request_id: params
                .get("requestId")
                .and_then(Value::as_str)
                .or_else(|| params.get("request_id").and_then(Value::as_str))
                .unwrap_or_default()
                .to_string(),
        });
    }

    let id = envelope
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing request id".to_string())?
        .to_string();

    let operation = match method {
        "initialize" => ServerOperation::Initialize(InitializeParams {
            client_name: params
                .get("client_name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            client_version: params
                .get("client_version")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        }),
        "doctor/run" => ServerOperation::Doctor {
            target_org: params
                .get("targetOrg")
                .and_then(Value::as_str)
                .or_else(|| params.get("target_org").and_then(Value::as_str))
                .map(str::to_string),
        },
        "org/list" => {
            let force_refresh = params
                .get("forceRefresh")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || params
                    .get("force_refresh")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
            ServerOperation::OrgList { force_refresh }
        }
        "org/auth" => ServerOperation::OrgAuth {
            username: params
                .get("username")
                .and_then(Value::as_str)
                .map(str::to_string),
        },
        "org/resolve" => ServerOperation::OrgResolve {
            target_org: params
                .get("targetOrg")
                .and_then(Value::as_str)
                .or_else(|| params.get("target_org").and_then(Value::as_str))
                .or_else(|| params.get("username").and_then(Value::as_str))
                .map(str::to_string),
        },
        "logs/list" => {
            let cursor = params.get("cursor").cloned().unwrap_or(Value::Null);
            ServerOperation::LogsList(LogsListParams {
                username: params
                    .get("username")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                limit: params
                    .get("limit")
                    .and_then(Value::as_u64)
                    .or_else(|| params.get("pageSize").and_then(Value::as_u64))
                    .or_else(|| params.get("page_size").and_then(Value::as_u64))
                    .map(|value| value as usize),
                cursor: LogsCursor {
                    before_start_time: cursor
                        .get("beforeStartTime")
                        .and_then(Value::as_str)
                        .or_else(|| cursor.get("before_start_time").and_then(Value::as_str))
                        .or_else(|| params.get("beforeStartTime").and_then(Value::as_str))
                        .or_else(|| params.get("before_start_time").and_then(Value::as_str))
                        .map(str::to_string),
                    before_id: cursor
                        .get("beforeId")
                        .and_then(Value::as_str)
                        .or_else(|| cursor.get("before_id").and_then(Value::as_str))
                        .or_else(|| params.get("beforeId").and_then(Value::as_str))
                        .or_else(|| params.get("before_id").and_then(Value::as_str))
                        .map(str::to_string),
                }
                .filter_active(),
                offset: params
                    .get("offset")
                    .and_then(Value::as_u64)
                    .map(|value| value as usize),
            })
        }
        "logs/sync" => ServerOperation::LogsSync(LogsSyncParams {
            target_org: params
                .get("targetOrg")
                .and_then(Value::as_str)
                .or_else(|| params.get("target_org").and_then(Value::as_str))
                .map(str::to_string),
            workspace_root: params
                .get("workspaceRoot")
                .and_then(Value::as_str)
                .or_else(|| params.get("workspace_root").and_then(Value::as_str))
                .map(str::to_string),
            force_full: params
                .get("forceFull")
                .and_then(Value::as_bool)
                .or_else(|| params.get("force_full").and_then(Value::as_bool))
                .unwrap_or(false),
            concurrency: params
                .get("concurrency")
                .and_then(Value::as_u64)
                .map(|value| value as usize),
        }),
        "logs/read" => ServerOperation::LogsRead(parse_params(params)?),
        "logs/delete" => ServerOperation::LogsDelete(parse_params(params)?),
        "search/query" => ServerOperation::SearchQuery(SearchQueryParams {
            query: params
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            log_ids: string_vec_field(&params, "logIds")
                .or_else(|| string_vec_field(&params, "log_ids"))
                .unwrap_or_default(),
            username: params
                .get("username")
                .and_then(Value::as_str)
                .map(str::to_string),
            raw_username: params
                .get("rawUsername")
                .and_then(Value::as_str)
                .or_else(|| params.get("raw_username").and_then(Value::as_str))
                .map(str::to_string),
            workspace_root: params
                .get("workspaceRoot")
                .and_then(Value::as_str)
                .or_else(|| params.get("workspace_root").and_then(Value::as_str))
                .map(str::to_string),
        }),
        "logs/triage" => ServerOperation::LogsTriage(LogsTriageParams {
            log_ids: string_vec_field(&params, "logIds")
                .or_else(|| string_vec_field(&params, "log_ids"))
                .unwrap_or_default(),
            log_start_times: string_map_field(&params, "logStartTimes")
                .or_else(|| string_map_field(&params, "log_start_times"))
                .unwrap_or_default(),
            username: params
                .get("username")
                .and_then(Value::as_str)
                .map(str::to_string),
            workspace_root: params
                .get("workspaceRoot")
                .and_then(Value::as_str)
                .or_else(|| params.get("workspace_root").and_then(Value::as_str))
                .map(str::to_string),
        }),
        "logs/resolveCachedPath" => {
            ServerOperation::ResolveCachedPath(logs_handler::ResolveCachedLogPathParams {
                log_id: params
                    .get("logId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                username: params
                    .get("username")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                workspace_root: params
                    .get("workspaceRoot")
                    .and_then(Value::as_str)
                    .or_else(|| params.get("workspace_root").and_then(Value::as_str))
                    .map(str::to_string),
            })
        }
        "logs/resolve" => ServerOperation::ResolveLogPath(parse_params(params)?),
        "users/search" => ServerOperation::UsersSearch(parse_params(params)?),
        "traceFlags/status" | "trace-flags/status" => {
            ServerOperation::TraceFlagStatus(parse_params(params)?)
        }
        "traceFlags/apply" | "trace-flags/apply" => {
            ServerOperation::TraceFlagApply(parse_params(params)?)
        }
        "traceFlags/remove" | "trace-flags/remove" => {
            ServerOperation::TraceFlagRemove(parse_params(params)?)
        }
        "debugLevels/list" | "debug-levels/list" => {
            ServerOperation::DebugLevelList(parse_params(params)?)
        }
        "debugLevels/get" | "debug-levels/get" => {
            ServerOperation::DebugLevelGet(parse_params(params)?)
        }
        "debugLevels/create" | "debug-levels/create" => {
            ServerOperation::DebugLevelCreate(parse_params(params)?)
        }
        "debugLevels/update" | "debug-levels/update" => {
            ServerOperation::DebugLevelUpdate(parse_params(params)?)
        }
        "debugLevels/delete" | "debug-levels/delete" => {
            ServerOperation::DebugLevelDelete(parse_params(params)?)
        }
        "tooling/query" => ServerOperation::ToolingQuery {
            target_org: params
                .get("targetOrg")
                .and_then(Value::as_str)
                .or_else(|| params.get("target_org").and_then(Value::as_str))
                .map(str::to_string),
            soql: params
                .get("soql")
                .and_then(Value::as_str)
                .or_else(|| params.get("query").and_then(Value::as_str))
                .unwrap_or_default()
                .to_string(),
        },
        "tooling/request/get" => ServerOperation::ToolingRequestGet {
            target_org: params
                .get("targetOrg")
                .and_then(Value::as_str)
                .or_else(|| params.get("target_org").and_then(Value::as_str))
                .map(str::to_string),
            path: params
                .get("path")
                .and_then(Value::as_str)
                .or_else(|| params.get("pathOrUrl").and_then(Value::as_str))
                .or_else(|| params.get("path_or_url").and_then(Value::as_str))
                .unwrap_or_default()
                .to_string(),
        },
        _ => ServerOperation::Unknown(method.to_string()),
    };

    Ok(ParsedRequest::Call(ServerCall { id, operation }))
}

fn is_cancelled_error(error: &str) -> bool {
    error.contains("request cancelled")
}

fn serialize_result<T: serde::Serialize>(value: &T) -> Result<String, ServerError> {
    serde_json::to_string(value).map_err(|error| {
        ServerError::from(format!("failed to serialize runtime response: {error}"))
    })
}

fn parse_params<T: DeserializeOwned>(params: Value) -> Result<T, String> {
    serde_json::from_value(params).map_err(|error| format!("invalid params: {error}"))
}

fn jsonrpc_result(id: &str, result_json: &str) -> String {
    format!(
        "{{\"jsonrpc\":\"2.0\",\"id\":\"{}\",\"result\":{result_json}}}",
        escape_json(id)
    )
}

fn jsonrpc_error(id: &str, code: i32, message: &str, data_json: Option<&str>) -> String {
    let data = data_json
        .map(|json| format!(",\"data\":{json}"))
        .unwrap_or_default();
    format!(
        "{{\"jsonrpc\":\"2.0\",\"id\":\"{}\",\"error\":{{\"code\":{code},\"message\":\"{}\"{data}}}}}",
        escape_json(id),
        escape_json(message)
    )
}

fn serialize_initialize_result(result: &InitializeResult) -> String {
    format!(
        "{{\"runtime_version\":\"{}\",\"cli_version\":\"{}\",\"protocol_version\":\"{}\",\"channel\":\"{}\",\"platform\":\"{}\",\"arch\":\"{}\",\"capabilities\":{{\"orgs\":{},\"logs\":{},\"search\":{},\"tail\":{},\"debug_flags\":{},\"doctor\":{}}},\"state_dir\":\"{}\",\"cache_dir\":\"{}\"}}",
        escape_json(&result.runtime_version),
        escape_json(&result.cli_version),
        escape_json(&result.protocol_version),
        escape_json(&result.channel),
        escape_json(&result.platform),
        escape_json(&result.arch),
        result.capabilities.orgs,
        result.capabilities.logs,
        result.capabilities.search,
        result.capabilities.tail,
        result.capabilities.debug_flags,
        result.capabilities.doctor,
        escape_json(&result.state_dir),
        escape_json(&result.cache_dir)
    )
}

fn string_vec_field(source: &Value, field: &str) -> Option<Vec<String>> {
    source.get(field).and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect()
    })
}

fn string_map_field(source: &Value, field: &str) -> Option<BTreeMap<String, String>> {
    source.get(field).and_then(Value::as_object).map(|items| {
        items
            .iter()
            .filter_map(|(key, value)| {
                let key = key.trim();
                let value = value.as_str()?.trim();
                if key.is_empty() || value.is_empty() {
                    None
                } else {
                    Some((key.to_string(), value.to_string()))
                }
            })
            .collect()
    })
}

fn escape_json(value: &str) -> String {
    let mut escaped = String::new();
    for character in value.chars() {
        match character {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            other if other.is_control() => {
                write!(&mut escaped, "\\u{:04x}", other as u32)
                    .expect("writing to a string should not fail");
            }
            other => escaped.push(other),
        }
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_channel_for_version_returns_stable_for_release_versions() {
        assert_eq!(release_channel_for_version("0.1.0"), "stable");
    }

    #[test]
    fn release_channel_for_version_returns_pre_release_for_prerelease_versions() {
        assert_eq!(release_channel_for_version("0.1.0-alpha.1"), "pre-release");
    }

    #[test]
    fn parse_request_line_reads_search_query_username() {
        let parsed = parse_request_line(
            r#"{
              "jsonrpc":"2.0",
              "id":"search:1",
              "method":"search/query",
              "params":{
                "query":"needle",
                "logIds":["07L000000000001AA"],
                "username":"selected@example.com",
                "workspaceRoot":"/tmp/demo"
              }
            }"#,
        )
        .expect("search/query request should parse");

        let ParsedRequest::Call(call) = parsed else {
            panic!("expected a normal call");
        };

        let ServerOperation::SearchQuery(params) = call.operation else {
            panic!("expected search/query operation");
        };

        assert_eq!(params.username.as_deref(), Some("selected@example.com"));
        assert_eq!(params.workspace_root.as_deref(), Some("/tmp/demo"));
        assert_eq!(params.log_ids, vec!["07L000000000001AA".to_string()]);
    }

    #[test]
    fn parse_request_line_reads_logs_triage_start_times() {
        let parsed = parse_request_line(
            r#"{
              "jsonrpc":"2.0",
              "id":"triage:1",
              "method":"logs/triage",
              "params":{
                "logIds":["07L000000000001AA"],
                "logStartTimes":{"07L000000000001AA":"2026-03-30T18:39:58.000Z"},
                "username":"selected@example.com",
                "workspaceRoot":"/tmp/demo"
              }
            }"#,
        )
        .expect("logs/triage request should parse");

        let ParsedRequest::Call(call) = parsed else {
            panic!("expected a normal call");
        };

        let ServerOperation::LogsTriage(params) = call.operation else {
            panic!("expected logs/triage operation");
        };

        assert_eq!(params.username.as_deref(), Some("selected@example.com"));
        assert_eq!(params.workspace_root.as_deref(), Some("/tmp/demo"));
        assert_eq!(params.log_ids, vec!["07L000000000001AA".to_string()]);
        assert_eq!(
            params
                .log_start_times
                .get("07L000000000001AA")
                .map(String::as_str),
            Some("2026-03-30T18:39:58.000Z")
        );
    }

    #[test]
    fn parse_request_line_reads_logs_sync_params() {
        let parsed = parse_request_line(
            r#"{
              "jsonrpc":"2.0",
              "id":"sync:1",
              "method":"logs/sync",
              "params":{
                "targetOrg":"selected@example.com",
                "workspaceRoot":"/tmp/demo",
                "forceFull":true,
                "concurrency":3
              }
            }"#,
        )
        .expect("logs/sync request should parse");

        let ParsedRequest::Call(call) = parsed else {
            panic!("expected a normal call");
        };

        let ServerOperation::LogsSync(params) = call.operation else {
            panic!("expected logs/sync operation");
        };

        assert_eq!(params.target_org.as_deref(), Some("selected@example.com"));
        assert_eq!(params.workspace_root.as_deref(), Some("/tmp/demo"));
        assert!(params.force_full);
        assert_eq!(params.concurrency, Some(3));
    }
}
