import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "p2p-file-transfer",
  matrixSlug: "drop",
  icon: "Send",
  name: "Local File Drop",
  description:
    "Send files straight from one browser to another over WebRTC, on the same Wi-Fi or across the internet, with no upload in between.",
  category: "Network",
  keywords: [
    "p2p file transfer",
    "send file to another device",
    "browser to browser file transfer",
    "share files on same wifi",
    "airdrop for windows and android",
    "webrtc file transfer",
    "snapdrop alternative",
    "local file sharing",
  ],
  searchTerms: [
    "drop",
    "local file drop",
    "peer to peer",
    "send big file without upload",
    "phone to laptop file transfer",
    "pc to phone transfer wifi",
    "sharedrop",
    "pairdrop",
    "wormhole",
    "nearby share browser",
    "cross platform airdrop",
    "transfer photos from iphone to windows",
    "lan file share",
    "direct file transfer",
    "wetransfer alternative no upload",
    "webrtc data channel transfer",
    "send file device to device",
    "no cloud file transfer",
    "qr code file transfer",
    "send file no account",
    "room code file share",
    "multiple device file transfer",
  ],
  input: "text/plain",
  output: "application/json",
  privacyNote:
    "Your files go straight to the device you choose over an encrypted peer connection and never to a server; the relay sees only the connection handshake.",
  copy: {
    what: "Local File Drop moves files from one device to another straight through the browser. One side opens the page and gets a six character room code, a link and a QR code; the other side opens that link or types the code and the two browsers connect to each other over WebRTC. From then on either side can drop in as many files as it likes and they stream directly to the other device, encrypted end to end, with live progress and a security code you can compare out loud. On the same Wi-Fi the bytes never leave the network at all. Across the internet they still travel device to device, and if the two networks cannot be joined directly the tool says so instead of quietly routing your files through a server.",
    how: "Open the tool on the first device and click Create a room. Show the QR code to the second device, send it the link, or read the code out and type it into the Join a room box on the second device's page. Once the two connect you will see the same eight character security code on both screens; if you care that nobody is in the middle, check that they match. Drop files onto the page or pick them, and the other side gets a prompt naming the files and their total size. It accepts, the files stream across, and each one appears with a save button as it finishes. Turn off the STUN option to keep the connection strictly on your local network.",
    why: "Sending a file to the phone next to you should not mean uploading it to a cloud, waiting, and downloading it again, and it should not need an app, an account or both devices to be from the same company. Snapdrop is good but only pairs devices on the same network, PairDrop adds room codes but its public instance can fall back to a TURN relay that carries your bytes through someone else's server, and WeTransfer and friends store your file on their servers and put a size cap or a paywall in front of you. This page has no upload at all: your files travel directly between the two browsers over an encrypted WebRTC channel. The only thing that touches a server is the tiny connection handshake, relayed in memory by a Cloudflare Worker that forwards SDP and ICE candidates for a few minutes and never sees, stores or logs a byte of file data. There is no relay for the file bytes on purpose, and the page is honest when a connection cannot be made without one.",
    faq: [
      {
        q: "Do my files go through your server?",
        a: "No. File bytes travel over a WebRTC data channel that runs directly between the two browsers and is encrypted with DTLS. The only server involved is a small signaling relay on Cloudflare that passes the connection offer, answer and network candidates between the two devices while they find each other; it holds them in memory for a few minutes, forwards them to the other side, and keeps nothing. It never sees file names or file contents. If the two devices cannot reach each other directly, for example behind two strict corporate firewalls, the transfer fails and says so rather than falling back to a relay.",
      },
      {
        q: "How big a file can I send?",
        a: "The transfer itself streams and has no fixed size limit, so multi gigabyte files work fine on a fast local network. The receiving browser holds each file in memory until you press save on it, so on a phone or a machine with little free RAM, very large files can hit browser limits. Send those one at a time and save each before accepting the next batch. Speed depends on the path: two laptops on the same Wi-Fi typically move tens of megabytes per second, and across the internet you are limited by the slower side's upload speed.",
      },
      {
        q: "What is the STUN option and why would I turn it off?",
        a: "STUN is a one time lookup that tells each browser what its public address looks like, which is what lets two devices on different networks find each other. It goes to Cloudflare's public STUN server, the same company that hosts this site, and carries no file data. Turn it off when both devices are on the same Wi-Fi or LAN and you want to be certain the connection stays inside your network; the browsers then use only local addresses. Leave it on for phone to laptop transfers over mobile data or between two different networks.",
      },
    ],
  },
};
