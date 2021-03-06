const { RTCPeerConnection } = require("wrtc");
const { beforeOffer } = require("./server_ffmpeg");
const { io } = require("./socketIoServer");

console.log("running - server.js");

const {
  PEER_CONNECTION_CONFIG,
  ICE_CANDIDATE,
  OFFER,
  ANSWER,
  NEW_PEER_ICE_CANDIDATE,
} = require("./pc_constants");

/*
서버 사이드에서 RTCPeerConnection을 만드는 경우:

1. WebSocket으로 계속 통신해주어야 한다.

2. Offered > Answer > OnIceCandidate > IceCandidate

- 트랙은 등록하고 Offer, Answer를 보내면 자동으로 교환된다.

3. ConnectionStateChange 
*/
let pcServer;
let uFrag;
const IS_CALLER = true;

io.on("connection", async (serverSocket) => {
  trace("[SocketIO] User connected");

  let closed = false;
  const closePeerConnection = () => {
    if (closed) return;
    closed = true;
    pcServer.close();
  };

  serverSocket.on("disconnect", () => {
    trace("[SocketIO] User disconnected");
    closePeerConnection();
  });

  serverSocket.on("error", (e) => {
    trace("[SocketIO] Error occurred:", e);
  });

  // 왜 iceServers 전달하면 closed가 되지?
  // ===> fixed. 이제 잘 작동함.
  // 이제 LB ip로 접속할 수 있게 됨. 나이스
  // unified-plan의 효과는 뭘까?
  pcServer = new RTCPeerConnection(PEER_CONNECTION_CONFIG);

  // 이거 안 됨.
  // setTimeout(() => {
  //   serverSocket.emit(
  //     NEW_PEER_ICE_CANDIDATE,
  //     `candidate:1234512345 1 udp 4294967295 192.168.219.191 35000 typ srflx generation 0 ufrag ${uFrag} network-id 1`
  //   );
  // }, 1000);

  trace(
    "new PC\n- connectionState:",
    pcServer.connectionState,
    "\n- SignalingState: ",
    pcServer.signalingState
  );
  // prepare recording
  beforeOffer(pcServer);

  /*
  아래는 구글 STUN 서버로부터 받은 ice candidate 이다.
  14.6.76.223이 공유기 IP 이다. 즉 LB 아이피와 대응된다.
  여기서 rport를 임의의 번호로 제공하면 된다.
  여기서 임의의 candidate만 원격으로 제공하면 된다.
  애초에 icecandidate은 그냥 ICE Framework에서 받아오는 것일 뿐,
  또한 어떤 IP와 Port로 들어오는지는 상관이 없다. 
  단지 방화벽 단에서 해당 포트가 열려만 있으면 된다.
  
  (RTCPeerConnection은 임의의 포트에 대해 listening 하고 있는 것이니까)

  1628445767.470:  Successfully added Ice Candidate:  {
    candidate: 'candidate:2750398185 1 udp 1685659391 14.6.76.223 56107 typ srflx raddr 192.168.219.191 rport 56107 generation 0 ufrag wduD network-id 1 network-cost 10',
    sdpMid: '0',
    sdpMLineIndex: 0
  }
  1628445767.499:  Successfully added Ice Candidate:  {
    candidate: 'candidate:3045104759 1 udp 1685987071 14.6.76.223 56102 typ srflx raddr 192.168.194.2 rport 56102 generation 0 ufrag wduD network-id 3',
    sdpMid: '0',
    sdpMLineIndex: 0
  }
  */
  pcServer.addEventListener(ICE_CANDIDATE, ({ candidate }) => {
    // trace("My new Ice Candidate: ", candidate);
    trace("Sending new ICE Candidate: ");
    serverSocket.emit(NEW_PEER_ICE_CANDIDATE, candidate);
  });

  // https://developer.mozilla.org/ko/docs/Web/API/RTCPeerConnection/onconnectionstatechange
  pcServer.addEventListener("connectionstatechange", () => {
    switch (pcServer.connectionState) {
      case "connected":
        // The connection has become fully connected
        trace("[WebRTC] User is fully connected");
        break;
      case "disconnected":
      case "failed":
        // One or more transports has terminated unexpectedly or in an error
        trace("[WebRTC] User is unexpectedly disconnected");
        closePeerConnection();
        break;
      case "closed":
        // The connection has been closed
        trace("[WebRTC] Connection closed");
        closePeerConnection();
        break;
    }
  });

  // onTrack은 알아서 되는듯. 일단 테스트 ㄱㄱ
  // 알아서 된다.

  serverSocket.on(NEW_PEER_ICE_CANDIDATE, async (candidate) => {
    // Connection이 연결되기도 전에 closed 됐다고 해서 짜증나서 제거함
    try {
      await pcServer.addIceCandidate(candidate);
      trace("Successfully added Ice Candidate: ", candidate);
    } catch (error) {
      trace("Error while adding an ICE Candidate: ", error.toString());
    }
  });

  // 시작점
  if (IS_CALLER) {
    try {
      const offerDesc = await pcServer.createOffer();

      // const idx = offerDesc.sdp.indexOf("ice-ufrag:") + "ice-ufrag:".length;
      // uFrag = offerDesc.sdp.substring(idx, idx + 4);
      // offerDesc.sdp = offerDesc.sdp.replaceAll("0.0.0.0", "192.168.219.191");

      // offerDesc.sdp +=
      //   "a=candidate:4234997325 1 udp 2043278322 192.168.219.191 5000 typ host\r\n";
      trace("Created Offer: ", offerDesc);
      await pcServer.setLocalDescription(offerDesc);
      serverSocket.emit(OFFER, offerDesc);
    } catch (error) {
      return trace("Error while creating Offer: ", error);
    }

    serverSocket.on(ANSWER, async (answerDesc) => {
      try {
        trace("Received Answer: ", answerDesc);
        await pcServer.setRemoteDescription(answerDesc);
        trace("Connection Succeeeded!");
      } catch (error) {
        return trace("Error while setRemoteDescription: ", error);
      }
    });
  } else {
    serverSocket.on(OFFER, async (offerDesc) => {
      try {
        trace("Received Offer: ");
        await pcServer.setRemoteDescription(offerDesc);
      } catch (error) {
        return trace("Error while setRemoteDescription: ", error);
      }

      let answerDesc;

      try {
        trace("Creating Answer: ");
        answerDesc = await pcServer.createAnswer();
      } catch (error) {
        return trace("Error while creating answer: ", error);
      }

      try {
        await pcServer.setLocalDescription(answerDesc);
        serverSocket.emit(ANSWER, answerDesc);
        trace("Connection Succeeeded!");
      } catch (error) {
        return trace("Error while setLocalDescription: ", error);
      }
    });
  }
});

function _placeholder() {
  // 1. RTCPeerConnection을 생성한다.
  pcServer = new RTCPeerConnection(null);
  trace("Created Server-side RTCPeerConnection");

  // 2. onicecandidate 콜백을 통해 생성된 RTCPeerConnectionIceEvent를 얻는다.
  // 2-1. RTCPeerConnectionIceEvent에서 내 RTCIceCandidate를 얻는다.
  // 2-2. 내 candidate를 WebSocket을 통해 상대에게 전달한다.
  // 2-3. 상대가 pc.addIceCandidate(내 candidate); 를 수행한다.
  pcServer.onicecandidate = (RTCPeerConnectionIceEvent) => {
    trace("Server-side IceCandidate Generated");
    const candidate = { RTCPeerConnectionIceEvent };
    // TODO: candidate를 websocket으로 전송하기

    // 아래 코드가 수행돼야 한다.
    // pcClient.addIceCandidate(candidate);

    // 위 코드는 실패할 수 있다.
    // .then(function onSuccess() {}, function onFailure(error) {});
    // 성공 여부를 반환해야 한다.
    // 실패 시 retry 로직을 작성해야 할 것이다.
  };
}

// 3. 녹화 서버이므로, 일방향으로 설정해야 한다. (즉, recvonly를 SDP에 반영해야 한다.)
// WHAT
// sdp 개요 https://brunch.co.kr/@linecard/141
/*
    3) a= (미디어의 방향)
    RTP 프로토콜이 전달하는 미디어 속성뿐만 아니라 미디어 방향도 표시합니다.   

    a=sendrecv
    단말은 미디어 송신 및 수신 가능 
    예) 전화기로 통화가 가능한 채널

    a=recvonly
    단말은 미디어 수신만 가능 
    예) 전화기로 링백톤 수신만 가능한 채널

    a=sendonly
    단말은 미디어 송신만 가능
    예) 마이크 기능만 있는 단말로 송신만 가능한 채널 

    a=inactive
    단말은 송신 및 수신이 불가능  
    예) 전화기에서 Hold 버튼을 누른 상태 

    별도의 언급이 없을 때는 'a=sendrecv'로 가정합니다. 미디어의 방향은 전화 부가 서비스를 구현 시 유용합니다. 
    예를 들어, 묵음 버튼을 누르면 SDP 협상을 통해 'a=recvonly'로 설정하면 듣기만 가능합니다. 
  */

// HOW
// https://stackoverflow.com/questions/50002099/webrtc-one-way-video-call
// https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpTransceiver
// https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpTransceiver/direction => 여기에 recvonly, sendrecv, sendonly, inactive 등이 있다!
// https://niccoloterreri.com/webrtc-with-transceivers
// pcServer.addTransceiver("video");
// pcServer.getTransceivers().forEach((t) => {
//   t.direction = "recvonly";
// });

// createOffer를 할 때 options을 주는 건 대부분의 option이 deprecated돼있다. (createOffer MDN 참조)

// 4. 먼저 주는 쪽에서 createOffer를 수행한다.
// Offer를 수행 시 RTCSessionDescription를 생성한다.
// 근데 sdp가 왜 저따구일까..?
/*
    RTCSessionDescription {
        sdp: "v=0\r\no=- 3270438221386651336 4 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=extmap-allow-mixed\r\na=msid-semantic: WMS\r\n"
        type: "offer"
    }
  */

// 5. 받은 쪽에선 createAnswer를 수행한다.
// Answer를 수행 시 setRemoteDescription(offer)를 수행하지 않으면 아래 오류가 발생한다.
/* Failed to execute 'createAnswer' on 'RTCPeerConnection': 
     PeerConnection cannot create an answer in a state other than 
     have-remote-offer or have-local-pranswer.
   */
// Answer는 아래와 같이 생성된다.
/*
    RTCSessionDescription {
        sdp: "v=0\r\no=- 3270438221386651336 6 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=extmap-allow-mixed\r\na=msid-semantic: WMS\r\n"
        type: "answer"
    }
*/

// logging utility
function trace(...arg) {
  var now = (Date.now() / 1000).toFixed(3);
  console.log(now + ": ", ...arg);
}
