//! Effect RPC JSON framing, byte for byte as effect 4's `RpcClient` writes it and as T3's server answers.
use serde_json::json;
use t3_wire::frame::{
    CauseEncoded, ClientMessage, ExitEncoded, RequestId, ServerMessage, decode_frame,
};

#[test]
fn client_messages_encode_as_effect_writes_them() {
    let request = ClientMessage::Request {
        id: 0,
        tag: "orchestration.subscribeShell".into(),
        payload: json!({ "afterSequence": 41 }),
        headers: vec![],
    };
    assert_eq!(
        request.encode(),
        r#"{"_tag":"Request","id":0,"tag":"orchestration.subscribeShell","payload":{"afterSequence":41},"headers":[]}"#
    );
    assert_eq!(
        ClientMessage::Ack { request_id: 7 }.encode(),
        r#"{"_tag":"Ack","requestId":7}"#
    );
    assert_eq!(
        ClientMessage::Interrupt { request_id: 7 }.encode(),
        r#"{"_tag":"Interrupt","requestId":7}"#
    );
    assert_eq!(ClientMessage::Ping.encode(), r#"{"_tag":"Ping"}"#);
    assert_eq!(ClientMessage::Eof.encode(), r#"{"_tag":"Eof"}"#);
}

#[test]
fn server_messages_decode() {
    let frames = decode_frame(
        r#"[{"_tag":"Chunk","requestId":3,"values":[{"kind":"synchronized"}]},
            {"_tag":"Exit","requestId":"3","exit":{"_tag":"Success"}},
            {"_tag":"Exit","requestId":4,"exit":{"_tag":"Success","value":{"sequence":9}}},
            {"_tag":"Exit","requestId":5,"exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"_tag":"ProjectReadFileError","message":"no","operation":"realpath-target"}}]}},
            {"_tag":"Exit","requestId":6,"exit":{"_tag":"Failure","cause":[{"_tag":"Interrupt","fiberId":12}]}},
            {"_tag":"Defect","defect":"boom"},
            {"_tag":"Pong"},
            {"_tag":"SomethingNew"}]"#,
    )
    .unwrap();
    assert_eq!(
        frames,
        vec![
            ServerMessage::Chunk {
                request_id: RequestId(3),
                values: vec![json!({ "kind": "synchronized" })]
            },
            ServerMessage::Exit {
                request_id: RequestId(3),
                exit: ExitEncoded::Success {
                    value: serde_json::Value::Null
                }
            },
            ServerMessage::Exit {
                request_id: RequestId(4),
                exit: ExitEncoded::Success {
                    value: json!({ "sequence": 9 })
                }
            },
            ServerMessage::Exit {
                request_id: RequestId(5),
                exit: ExitEncoded::Failure {
                    cause: vec![CauseEncoded::Fail {
                        error: json!({ "_tag": "ProjectReadFileError", "message": "no", "operation": "realpath-target" })
                    }]
                }
            },
            ServerMessage::Exit {
                request_id: RequestId(6),
                exit: ExitEncoded::Failure {
                    cause: vec![CauseEncoded::Interrupt {
                        fiber_id: Some(json!(12))
                    }]
                }
            },
            ServerMessage::Defect {
                defect: json!("boom")
            },
            ServerMessage::Pong,
            ServerMessage::Unknown,
        ]
    );
    assert_eq!(
        decode_frame(r#"{"_tag":"Pong"}"#).unwrap(),
        vec![ServerMessage::Pong]
    );
}
