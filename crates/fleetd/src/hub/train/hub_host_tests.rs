//! The hub's `TrainHost` on a real hub: which projects a lead's person sees, for `change_enqueue`'s `after` (D338).
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::model::ProjectCreator;
use fleetd_contracts::people::PersonId;

use crate::hub::api::{HubConfig, Listen};
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;

fn project(id: &str) -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("devbox"),
        project_id: ProjectId::unchecked(id),
    }
}

/// An Only me project's lead sees its owner's projects and every shared one, never another person's Only me project;
/// a shared project's lead sees only what every person does.
#[test]
fn a_leads_person_sees_shared_projects_and_their_own_only_me_ones() {
    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: None,
    };
    let db = HubDb::open(home.path()).unwrap();
    let hub = crate::hub::serve::build_on(db, config, ManualClock::at(1_792_000_000_000)).unwrap();
    let only_me = |r: &ProjectRef, owner: &str| {
        hub.db
            .with(|c| {
                crate::hub::navi::store::put(
                    c,
                    r,
                    &ProjectCreator {
                        key_id: format!("k_{owner}"),
                        name: "desk".into(),
                    },
                    Some(&PersonId::unchecked(owner)),
                    0,
                )?;
                Ok(())
            })
            .unwrap();
    };
    let (ann, ann2, bob, shared) = (
        project("ann"),
        project("ann2"),
        project("bob"),
        project("shared"),
    );
    only_me(&ann, "p_ann");
    only_me(&ann2, "p_ann");
    only_me(&bob, "p_bob");
    let host = hub.train.host();

    assert!(host.sees(&ann, &ann));
    assert!(host.sees(&ann, &ann2));
    assert!(host.sees(&ann, &shared));
    assert!(!host.sees(&ann, &bob));
    assert!(host.sees(&shared, &shared));
    assert!(!host.sees(&shared, &ann));
    assert!(!host.sees(&shared, &bob));
}
