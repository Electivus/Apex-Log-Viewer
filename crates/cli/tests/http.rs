use apex_log_viewer_cli::http::{build_logs_query, build_query_url};

#[test]
fn build_logs_query_includes_limit_and_order() {
  let query = build_logs_query(25);
  assert!(query.contains("FROM ApexLog"));
  assert!(query.contains("ORDER BY StartTime DESC, Id DESC"));
  assert!(query.contains("LIMIT 25"));
}

#[test]
fn build_query_url_encodes_soql_and_trims_slash() {
  let soql = "SELECT Id FROM ApexLog LIMIT 1";
  let url = build_query_url("https://example.my.salesforce.com/", "64.0", soql);
  assert!(url.starts_with("https://example.my.salesforce.com/services/data/v64.0/tooling/query?q="));
  assert!(url.contains("SELECT%20Id%20FROM%20ApexLog%20LIMIT%201"));
}
