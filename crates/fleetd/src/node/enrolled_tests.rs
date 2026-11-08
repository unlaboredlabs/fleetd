//! A node service that starts before its config is there waits for it rather than exiting (`node::enrolled`).
use std::time::Duration;

use super::{enrolled, enrolled_retry};

#[test]
fn the_wait_doubles_up_to_five_minutes() {
    let waits: Vec<u64> = (0..9).map(|n| enrolled_retry(n).as_secs()).collect();
    assert_eq!(waits, [5, 10, 20, 40, 80, 160, 300, 300, 300]);
    assert_eq!(enrolled_retry(u32::MAX).as_secs(), 300);
}

#[tokio::test(start_paused = true)]
async fn a_service_waits_for_its_config_and_a_hand_run_says_so_at_once() {
    let home = tempfile::tempdir().unwrap();
    let by_hand = enrolled(home.path(), false).await.unwrap_err();
    assert!(
        by_hand.to_string().contains("has not joined a hub"),
        "{by_hand}"
    );
    let path = home.path().to_owned();
    let service = tokio::spawn(async move { enrolled(&path, true).await });
    // An hour of retries later it is still waiting, and the config, once written, is read on the next try.
    tokio::time::sleep(Duration::from_secs(3600)).await;
    assert!(!service.is_finished());
    std::fs::write(
        home.path().join("node.json"),
        r#"{"hub":"http://devbox:4790","machineId":"devbox","name":"devbox","enrolled":true}"#,
    )
    .unwrap();
    tokio::time::sleep(Duration::from_secs(301)).await;
    let config = service.await.unwrap().unwrap();
    assert_eq!(config.machine_id, "devbox");
}
