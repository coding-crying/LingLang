"""Real local ICE/DTLS/RTP probe using silent test tracks, no cloud calls."""
import asyncio
import unittest
from aiortc import RTCPeerConnection, RTCConfiguration, RTCSessionDescription, AudioStreamTrack
from pipecat.transports.smallwebrtc.request_handler import SmallWebRTCRequest, SmallWebRTCRequestHandler

class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_smallwebrtc_bidirectional_audio(self):
        client=RTCPeerConnection(RTCConfiguration(iceServers=[]))
        handler=SmallWebRTCRequestHandler(ice_servers=[])
        source=AudioStreamTrack()
        output=AudioStreamTrack()
        client.addTrack(source)
        channel=client.createDataChannel('pipecat')
        remote_track=asyncio.get_running_loop().create_future()
        connection_ready=asyncio.get_running_loop().create_future()
        @client.on('track')
        def track_received(track):
            if track.kind=='audio' and not remote_track.done():remote_track.set_result(track)
        async def callback(connection):
            connection.replace_audio_track(output)
            await connection.connect()
            connection_ready.set_result(connection)
        try:
            await client.setLocalDescription(await client.createOffer())
            answer=await handler.handle_web_request(SmallWebRTCRequest(sdp=client.localDescription.sdp,type='offer',request_data={'ticket':'transport-only-fixture'}),callback)
            self.assertEqual(answer['type'],'answer')
            self.assertTrue(answer['pc_id'])
            await client.setRemoteDescription(RTCSessionDescription(sdp=answer['sdp'],type=answer['type']))
            connection=await connection_ready
            remote=await asyncio.wait_for(remote_track,5)
            incoming,outgoing=await asyncio.wait_for(asyncio.gather(connection.audio_input_track().recv(),remote.recv()),10)
            self.assertGreater(incoming.samples,0)
            self.assertGreater(outgoing.samples,0)
            self.assertEqual(client.connectionState,'connected')
            self.assertTrue(connection.is_connected())
            print(f'Actual RTP audio received: server={incoming.samples} samples, client={outgoing.samples} samples; ICE/DTLS connected')
        finally:
            source.stop();output.stop()
            await client.close()
            await handler.close()
