use tokio::sync::mpsc;

pub const TRANSPORT_QUEUE_CAPACITY: usize = 64;

pub fn bounded_transport_channel<T>() -> (mpsc::Sender<T>, mpsc::Receiver<T>) {
    mpsc::channel(TRANSPORT_QUEUE_CAPACITY)
}
