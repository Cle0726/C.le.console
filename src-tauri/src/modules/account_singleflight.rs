//! Per-account single-flight; closing a window cannot cancel a rotating token request.
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

type Flights<T> = Arc<Mutex<HashMap<String, watch::Receiver<Option<T>>>>>;
struct RemoveFlight<T> {
    flights: Flights<T>,
    key: String,
}
impl<T> Drop for RemoveFlight<T> {
    fn drop(&mut self) {
        if let Ok(mut flights) = self.flights.lock() {
            flights.remove(&self.key);
        }
    }
}
pub(super) struct SingleFlight<T> {
    flights: Flights<T>,
}
impl<T> Default for SingleFlight<T> {
    fn default() -> Self {
        Self {
            flights: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}
impl<T: Clone + Send + Sync + 'static> SingleFlight<T> {
    pub(super) async fn run<F, Fut>(&self, key: String, work: F) -> Result<T, String>
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = T> + Send + 'static,
    {
        let mut receiver = {
            let mut flights = self.flights.lock().map_err(|_| "账号刷新状态锁损坏")?;
            if let Some(existing) = flights.get(&key) {
                existing.clone()
            } else {
                let (sender, receiver) = watch::channel(None);
                flights.insert(key.clone(), receiver.clone());
                let registry = self.flights.clone();
                tokio::spawn(async move {
                    let _cleanup = RemoveFlight {
                        flights: registry,
                        key,
                    };
                    let result = work().await;
                    // Publish before removing; all existing waiters share it.
                    sender.send_replace(Some(result));
                });
                receiver
            }
        };
        loop {
            if let Some(result) = receiver.borrow().clone() {
                return Ok(result);
            }
            receiver
                .changed()
                .await
                .map_err(|_| "账号刷新任务中断；原账号已保留")?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    #[tokio::test]
    async fn overlapping_callers_share_one_request() {
        let flights = Arc::new(SingleFlight::<usize>::default());
        let count = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new(tokio::sync::Notify::new());
        let mut jobs = Vec::new();
        for _ in 0..8 {
            let flights = flights.clone();
            let count = count.clone();
            let gate = gate.clone();
            jobs.push(tokio::spawn(async move {
                flights
                    .run("fixture".into(), move || async move {
                        count.fetch_add(1, Ordering::SeqCst);
                        gate.notified().await;
                        42
                    })
                    .await
                    .unwrap()
            }));
        }
        while count.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        for _ in 0..16 {
            tokio::task::yield_now().await;
        }
        gate.notify_waiters();
        for job in jobs {
            assert_eq!(job.await.unwrap(), 42);
        }
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn cancellation_of_the_last_caller_does_not_cancel_the_worker() {
        let flights = Arc::new(SingleFlight::<usize>::default());
        let completed = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(tokio::sync::Notify::new());
        let gate = Arc::new(tokio::sync::Notify::new());
        let f = flights.clone();
        let c = completed.clone();
        let s = started.clone();
        let g = gate.clone();
        let caller = tokio::spawn(async move {
            f.run("fixture".into(), move || async move {
                s.notify_one();
                g.notified().await;
                c.store(1, Ordering::SeqCst);
                7
            })
            .await
        });
        started.notified().await;
        caller.abort();
        gate.notify_one();
        for _ in 0..100 {
            if completed.load(Ordering::SeqCst) == 1 {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(completed.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_panicked_worker_does_not_permanently_block_the_account() {
        let flights = SingleFlight::<usize>::default();
        assert!(flights
            .run("fixture".into(), || async {
                panic!("synthetic worker failure")
            })
            .await
            .is_err());
        assert_eq!(
            flights.run("fixture".into(), || async { 9 }).await.unwrap(),
            9
        );
    }
}
