use tokio::sync::mpsc;

pub const TRANSPORT_QUEUE_CAPACITY: usize = 64;
pub type JsonlMessage = String;

pub fn bounded_transport_channel<T>() -> (mpsc::Sender<T>, mpsc::Receiver<T>) {
    mpsc::channel(TRANSPORT_QUEUE_CAPACITY)
}

pub fn bounded_jsonl_transport_channel(
) -> (mpsc::Sender<JsonlMessage>, mpsc::Receiver<JsonlMessage>) {
    bounded_transport_channel()
}
