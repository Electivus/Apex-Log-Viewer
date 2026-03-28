use alv_core::{
    logs::{list_logs, LogsListParams},
    search::{search_query, SearchQueryParams},
    triage::{triage_logs, LogsTriageParams},
};

pub fn handle_logs_list(params: LogsListParams) -> Result<String, String> {
    let rows = list_logs(&params)?;
    serde_json::to_string(&rows)
        .map_err(|error| format!("failed to serialize logs/list response: {error}"))
}

pub fn handle_search_query(params: SearchQueryParams) -> Result<String, String> {
    let result = search_query(&params)?;
    serde_json::to_string(&result)
        .map_err(|error| format!("failed to serialize search/query response: {error}"))
}

pub fn handle_logs_triage(params: LogsTriageParams) -> Result<String, String> {
    let items = triage_logs(&params)?;
    serde_json::to_string(&items)
        .map_err(|error| format!("failed to serialize logs/triage response: {error}"))
}
