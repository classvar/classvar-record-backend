/*
 *  Copyright (c) 2016 The WebRTC project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree.
 */
/* global TimelineDataSeries, TimelineGraphView */

"use strict";

// websocket!
const socket = io("https://localhost:3000/");

const remoteVideo = document.querySelector("video#remoteVideo");
const localVideo = document.querySelector("video#localVideo");
const callButton = document.querySelector("button#callButton");
const hangupButton = document.querySelector("button#hangupButton");
const bandwidthSelector = document.querySelector("select#bandwidth");
hangupButton.disabled = true;
callButton.onclick = call;
hangupButton.onclick = hangup;

let pc1;
let pc2;
let localStream;

// Can be set in the console before making a call to test this keeps
// within the envelope set by the SDP. In kbps.
// eslint-disable-next-line prefer-const
let maxBandwidth = 0;

let lastResult;

const offerOptions = {
  offerToReceiveAudio: 0,
  offerToReceiveVideo: 1,
};

function gotStream(stream) {
  hangupButton.disabled = false;
  console.log("Received local stream");
  localStream = stream;
  localVideo.srcObject = stream;
  localStream.getTracks().forEach((track) => pc1.addTrack(track, localStream));
  console.log("Adding Local Stream to peer connection");

  pc1
    .createOffer(offerOptions)
    .then(gotDescription1, onCreateSessionDescriptionError);
}

function onCreateSessionDescriptionError(error) {
  console.log("Failed to create session description: " + error.toString());
}

function call() {
  callButton.disabled = true;
  bandwidthSelector.disabled = false;
  console.log("Starting call");
  const servers = null;
  pc1 = new RTCPeerConnection(servers);
  console.log("Created local peer connection object pc1");
  pc1.onicecandidate = onIceCandidate.bind(pc1);

  pc2 = new RTCPeerConnection(servers);
  console.log("Created remote peer connection object pc2");
  pc2.onicecandidate = onIceCandidate.bind(pc2);
  pc2.ontrack = gotRemoteStream;

  console.log("Requesting local stream");
  navigator.mediaDevices
    .getUserMedia({ video: true })
    .then(gotStream)
    .catch((e) => alert("getUserMedia() error: " + e));
}

function gotDescription1(desc) {
  console.log("Offer from pc1 \n" + desc.sdp);
  pc1.setLocalDescription(desc).then(() => {
    pc2
      .setRemoteDescription(desc)
      .then(
        () =>
          pc2
            .createAnswer()
            .then(gotDescription2, onCreateSessionDescriptionError),
        onSetSessionDescriptionError
      );
  }, onSetSessionDescriptionError);
}

function gotDescription2(desc) {
  pc2.setLocalDescription(desc).then(() => {
    console.log("Answer from pc2 \n" + desc.sdp);
    let p;
    if (maxBandwidth) {
      p = pc1.setRemoteDescription({
        type: desc.type,
        sdp: updateBandwidthRestriction(desc.sdp, maxBandwidth),
      });
    } else {
      p = pc1.setRemoteDescription(desc);
    }
    p.then(() => {}, onSetSessionDescriptionError);
  }, onSetSessionDescriptionError);
}

function hangup() {
  console.log("Ending call");
  localStream.getTracks().forEach((track) => track.stop());
  pc1.close();
  pc2.close();
  pc1 = null;
  pc2 = null;
  hangupButton.disabled = true;
  callButton.disabled = false;
  bandwidthSelector.disabled = true;
}

function gotRemoteStream(e) {
  const stream = e.streams[0];
  if (remoteVideo.srcObject !== stream) {
    remoteVideo.srcObject = stream;
    console.log("Received remote stream");

    // MediaRecorder
    const RECORDER_UPLOAD_TIME_SLICE = 500;
    const recordedBlobs = [];
    const handleDataAvailable = (event) => {
      console.log("handleDataAvailable", event);
      if (event.data && event.data.size > 0) {
        recordedBlobs.push(event.data);
        socket.emit("upload", event.data);
        console.log("data:", event.data);
      }
    };
    const mimeType = "video/webm;codecs=vp9,opus";
    const audioBitsPerSecond = 128000;
    const videoBitsPerSecond = 125 * 8 * 1024; // byte * kilo
    const options = { mimeType, audioBitsPerSecond, videoBitsPerSecond };
    const startRecording = () => {
      const mediaRecorder = new MediaRecorder(stream, options);
      mediaRecorder.onstop = (event) => {
        console.log("Recorder stopped: ", event);
        console.log("Recorded Blobs: ", recordedBlobs);
        socket.emit("stop");
      };
      mediaRecorder.ondataavailable = handleDataAvailable;
      mediaRecorder.start(RECORDER_UPLOAD_TIME_SLICE);
      setTimeout(mediaRecorder.stop, 5000);
    };
    socket.once("ready", startRecording);
    socket.emit("start");
    console.log("emitting start event");
  }
}

function getOtherPc(pc) {
  return pc === pc1 ? pc2 : pc1;
}

function getName(pc) {
  return pc === pc1 ? "pc1" : "pc2";
}

function onIceCandidate(event) {
  getOtherPc(this)
    .addIceCandidate(event.candidate)
    .then(onAddIceCandidateSuccess)
    .catch(onAddIceCandidateError);

  console.log(
    `${getName(this)} ICE candidate:\n${
      event.candidate ? event.candidate.candidate : "(null)"
    }`
  );
}

function onAddIceCandidateSuccess() {
  console.log("AddIceCandidate success.");
}

function onAddIceCandidateError(error) {
  console.log("Failed to add ICE Candidate: " + error.toString());
}

function onSetSessionDescriptionError(error) {
  console.log("Failed to set session description: " + error.toString());
}

// renegotiate bandwidth on the fly.
bandwidthSelector.onchange = () => {
  bandwidthSelector.disabled = true;
  const bandwidth =
    bandwidthSelector.options[bandwidthSelector.selectedIndex].value;

  // In Chrome, use RTCRtpSender.setParameters to change bandwidth without
  // (local) renegotiation. Note that this will be within the envelope of
  // the initial maximum bandwidth negotiated via SDP.
  if (
    "RTCRtpSender" in window &&
    "setParameters" in window.RTCRtpSender.prototype
  ) {
    const sender = pc1.getSenders()[0];
    const parameters = sender.getParameters();
    if (!parameters.encodings) {
      parameters.encodings = [{}];
    }
    if (bandwidth === "unlimited") {
      delete parameters.encodings[0].maxBitrate;
    } else {
      parameters.encodings[0].maxBitrate = bandwidth * 1000;
    }
    sender
      .setParameters(parameters)
      .then(() => {
        bandwidthSelector.disabled = false;
      })
      .catch((e) => console.error(e));
    return;
  }
  // Fallback to the SDP munging with local renegotiation way of limiting
  // the bandwidth.
  pc1
    .createOffer()
    .then((offer) => pc1.setLocalDescription(offer))
    .then(() => {
      const desc = {
        type: pc1.remoteDescription.type,
        sdp:
          bandwidth === "unlimited"
            ? removeBandwidthRestriction(pc1.remoteDescription.sdp)
            : updateBandwidthRestriction(pc1.remoteDescription.sdp, bandwidth),
      };
      console.log(
        "Applying bandwidth restriction to setRemoteDescription:\n" + desc.sdp
      );
      return pc1.setRemoteDescription(desc);
    })
    .then(() => {
      bandwidthSelector.disabled = false;
    })
    .catch(onSetSessionDescriptionError);
};

function updateBandwidthRestriction(sdp, bandwidth) {
  let modifier = "AS";
  if (sdp.indexOf("b=" + modifier + ":") === -1) {
    // insert b= after c= line.
    sdp = sdp.replace(
      /c=IN (.*)\r\n/,
      "c=IN $1\r\nb=" + modifier + ":" + bandwidth + "\r\n"
    );
  } else {
    sdp = sdp.replace(
      new RegExp("b=" + modifier + ":.*\r\n"),
      "b=" + modifier + ":" + bandwidth + "\r\n"
    );
  }
  return sdp;
}

function removeBandwidthRestriction(sdp) {
  return sdp.replace(/b=AS:.*\r\n/, "").replace(/b=TIAS:.*\r\n/, "");
}

// query getStats every second
window.setInterval(() => {
  if (!pc1) {
    return;
  }
  const sender = pc1.getSenders()[0];
  if (!sender) {
    return;
  }
  sender.getStats().then((res) => {
    res.forEach((report) => {
      let bytes;
      let headerBytes;
      if (report.type === "outbound-rtp") {
        if (report.isRemote) {
          return;
        }
        const now = report.timestamp;
        bytes = report.bytesSent;
        headerBytes = report.headerBytesSent;

        if (lastResult && lastResult.has(report.id)) {
          // calculate bitrate
          const bitrate =
            (8 * (bytes - lastResult.get(report.id).bytesSent)) /
            (now - lastResult.get(report.id).timestamp);
          const headerrate =
            (8 * (headerBytes - lastResult.get(report.id).headerBytesSent)) /
            (now - lastResult.get(report.id).timestamp);
          console.log("birate: %s, headerrate: %s", bitrate, headerrate);
        }
      }
    });
    lastResult = res;
  });
}, 1000);
