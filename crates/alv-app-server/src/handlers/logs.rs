use alv_core::{
    logs::{list_logs_with_cancel, CancellationToken, LogsListParams},
    search::{search_query_with_cancel, SearchQueryParams},
    triage::{triage_logs_with_cancel, LogsTriageParams},
};

pub fn handle_logs_list_with_cancel(
    params: LogsListParams,
    cancellation: &CancellationToken,
) -> Result<String, String> {
    let rows = list_logs_with_cancel(&params, cancellation)?;
    serde_json::to_string(&rows)
        .map_err(|error| format!("failed to serialize logs/list response: {error}"))
}

pub fn handle_search_query_with_cancel(
    params: SearchQueryParams,
    cancellation: &CancellationToken,
) -> Result<String, String> {
    let result = search_query_with_cancel(&params, cancellation)?;
    serde_json::to_string(&result)
        .map_err(|error| format!("failed to serialize search/query response: {error}"))
}

pub fn handle_logs_triage_with_cancel(
    params: LogsTriageParams,
    cancellation: &CancellationToken,
) -> Result<String, String> {
    let items = triage_logs_with_cancel(&params, cancellation)?;
    serde_json::to_string(&items)
        .map_err(|error| format!("failed to serialize logs/triage response: {error}"))
}
