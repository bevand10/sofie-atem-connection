/**
 * Note: this file wants as few imports as possible, as it gets loaded in a worker-thread and may require its own webpack bundle
 */
import { createSocket, Socket, RemoteInfo } from 'dgram'
import * as NanoTimer from 'nanotimer'

const IN_FLIGHT_TIMEOUT = 60 // ms
const CONNECTION_TIMEOUT = 5000 // ms
const CONNECTION_RETRY_INTERVAL = 1000 // ms
const MAX_PACKET_RETRIES = 10
const MAX_PACKET_ID = 1 << 15 // Atem expects 15 not 16 bits before wrapping
const MAX_PACKET_PER_ACK = 16

export const COMMAND_CONNECT_HELLO = Buffer.from([
	0x10, 0x14, 0x53, 0xab, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3a, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00,
])

export enum ConnectionState {
	Closed = 0x00,
	SynSent = 0x01,
	Established = 0x02,
}

export enum PacketFlag {
	AckRequest = 0x01,
	NewSessionId = 0x02,
	IsRetransmit = 0x04,
	RetransmitRequest = 0x08,
	AckReply = 0x10,
}

interface InFlightPacket {
	readonly packetId: number
	readonly trackingId: number
	readonly payload: Buffer
	lastSent: number
	resent: number
}

export class AtemSocketChild {
	private readonly _debugBuffers: boolean

	private _connectionState = ConnectionState.Closed
	private _reconnectTimer: NodeJS.Timer | undefined
	private _retransmitTimer: NodeJS.Timer | undefined

	private _nextSendPacketId = 1
	private _sessionId = 0

	private _address: string
	private _port: number
	private _socket: Socket

	private _lastReceivedAt: number = Date.now()
	private _lastReceivedPacketId = 0
	private _inFlight: InFlightPacket[] = []
	private readonly _ackTimer = new NanoTimer()
	private _ackTimerRunning = false
	private _receivedWithoutAck = 0

	private readonly onDisconnect: () => Promise<void>
	private readonly onLog: (message: string) => Promise<void>
	private readonly onCommandsReceived: (payload: Buffer, packetId: number) => Promise<void>
	private readonly onCommandsAcknowledged: (ids: Array<{ packetId: number; trackingId: number }>) => Promise<void>

	constructor(
		options: { address: string; port: number; debugBuffers: boolean },
		onDisconnect: () => Promise<void>,
		onLog: (message: string) => Promise<void>,
		onCommandReceived: (payload: Buffer, packetId: number) => Promise<void>,
		onCommandAcknowledged: (ids: Array<{ packetId: number; trackingId: number }>) => Promise<void>
	) {
		this._debugBuffers = options.debugBuffers
		this._address = options.address
		this._port = options.port

		this.onDisconnect = onDisconnect
		this.onLog = onLog
		this.onCommandsReceived = onCommandReceived
		this.onCommandsAcknowledged = onCommandAcknowledged

		this._socket = this._createSocket()
	}

	private startTimers(): void {
		if (!this._reconnectTimer) {
			this._reconnectTimer = setInterval(() => {
				if (this._lastReceivedAt + CONNECTION_TIMEOUT > Date.now()) {
					// We heard from the atem recently
					return
				}

				this.restartConnection().catch((e) => {
					this.log(`Reconnect failed: ${e}`)
				})
			}, CONNECTION_RETRY_INTERVAL)
		}
		// Check for retransmits every 10 milliseconds
		if (!this._retransmitTimer) {
			this._retransmitTimer = setInterval(() => {
				this._checkForRetransmit().catch((e) => {
					this.log(`Failed to retransmit: ${e?.message ?? e}`)
				})
			}, 10)
		}
	}

	public async connect(address: string, port: number): Promise<void> {
		this.startTimers()

		this._address = address
		this._port = port

		return this.restartConnection()
	}

	public async disconnect(): Promise<void> {
		// Stop timers, as they just cause pointless work now.
		if (this._retransmitTimer) {
			clearInterval(this._retransmitTimer)
			this._retransmitTimer = undefined
		}
		if (this._reconnectTimer) {
			clearInterval(this._reconnectTimer)
			this._reconnectTimer = undefined
		}

		return new Promise<void>((resolve) => {
			try {
				this._socket.close(() => resolve())
			} catch (e) {
				resolve()
			}
		}).then(async () => {
			this._connectionState = ConnectionState.Closed
			this._createSocket()
			return this.onDisconnect()
		})
	}

	private async restartConnection(): Promise<void> {
		// This includes a 'disconnect'
		if (this._connectionState === ConnectionState.Established) {
			this._connectionState = ConnectionState.Closed
			this._createSocket()
			await this.onDisconnect()
		}

		// Reset connection
		this._nextSendPacketId = 1
		this._sessionId = 0
		this._inFlight = []
		this.log('reconnect')

		// Try doing reconnect
		this._sendPacket(COMMAND_CONNECT_HELLO)
		this._connectionState = ConnectionState.SynSent
	}

	private log(message: string): void {
		// tslint:disable-next-line: no-floating-promises
		void this.onLog(message)
	}

	public sendCommands(commands: Array<{ payload: number[]; rawName: string; trackingId: number }>): void {
		commands.forEach((cmd) => {
			this.sendCommand(cmd.payload, cmd.rawName, cmd.trackingId)
		})
	}

	private sendCommand(payload: number[], rawName: string, trackingId: number): void {
		const packetId = this._nextSendPacketId++
		if (this._nextSendPacketId >= MAX_PACKET_ID) this._nextSendPacketId = 0

		const opcode = PacketFlag.AckRequest << 11

		const buffer = Buffer.alloc(20 + payload.length, 0)
		buffer.writeUInt16BE(opcode | (payload.length + 20), 0) // Opcode & Length
		buffer.writeUInt16BE(this._sessionId, 2)
		buffer.writeUInt16BE(packetId, 10)

		// Command
		buffer.writeUInt16BE(payload.length + 8, 12)
		buffer.write(rawName, 16, 4)

		// Body
		Buffer.from(payload).copy(buffer, 20)
		this._sendPacket(buffer)

		this._inFlight.push({
			packetId,
			trackingId,
			lastSent: Date.now(),
			payload: buffer,
			resent: 0,
		})
	}

	private _createSocket(): Socket {
		this._socket = createSocket('udp4')
		this._socket.bind()
		this._socket.on('message', (packet, rinfo) => this._receivePacket(packet, rinfo))
		this._socket.on('error', (err) => {
			this.log(`Connection error: ${err}`)

			if (this._connectionState === ConnectionState.Established) {
				// If connection is open, then restart. Otherwise the reconnectTimer will handle it
				this.restartConnection().catch((e) => {
					this.log(`Failed to restartConnection: ${e?.message ?? e}`)
				})
			}
		})

		return this._socket
	}

	private _isPacketCoveredByAck(ackId: number, packetId: number): boolean {
		const tolerance = MAX_PACKET_ID / 2
		const pktIsShortlyBefore = packetId < ackId && packetId + tolerance > ackId
		const pktIsShortlyAfter = packetId > ackId && packetId < ackId + tolerance
		const pktIsBeforeWrap = packetId > ackId + tolerance
		return packetId === ackId || ((pktIsShortlyBefore || pktIsBeforeWrap) && !pktIsShortlyAfter)
	}

	private _receivePacket(packet: Buffer, rinfo: RemoteInfo): void {
		if (this._debugBuffers) this.log(`RECV ${packet.toString('hex')}`)
		this._lastReceivedAt = Date.now()
		const length = packet.readUInt16BE(0) & 0x07ff
		if (length !== rinfo.size) return

		const flags = packet.readUInt8(0) >> 3
		this._sessionId = packet.readUInt16BE(2)
		const remotePacketId = packet.readUInt16BE(10)

		// Send hello answer packet when receive connect flags
		if (flags & PacketFlag.NewSessionId) {
			this._connectionState = ConnectionState.Established
			this._lastReceivedPacketId = remotePacketId
			this._sendAck(remotePacketId)
			return
		}

		const ps: Array<Promise<void>> = []

		if (this._connectionState === ConnectionState.Established) {
			// Device asked for retransmit
			if (flags & PacketFlag.RetransmitRequest) {
				const fromPacketId = packet.readUInt16BE(6)
				this.log(`Retransmit request: ${fromPacketId}`)

				ps.push(this._retransmitFrom(fromPacketId))
			}

			// Got a packet that needs an ack
			if (flags & PacketFlag.AckRequest) {
				// Check if it next in the sequence
				if (remotePacketId === (this._lastReceivedPacketId + 1) % MAX_PACKET_ID) {
					this._lastReceivedPacketId = remotePacketId
					this._sendOrQueueAck()

					// It might have commands
					if (length > 12) {
						ps.push(this.onCommandsReceived(packet.slice(12), remotePacketId))
					}
				} else if (this._isPacketCoveredByAck(this._lastReceivedPacketId, remotePacketId)) {
					// We got a retransmit of something we have already acked, so reack it
					this._sendOrQueueAck()
				}
			}

			// Device ack'ed our packet
			if (flags & PacketFlag.AckReply) {
				const ackPacketId = packet.readUInt16BE(4)
				const ackedCommands: Array<{ packetId: number; trackingId: number }> = []
				this._inFlight = this._inFlight.filter((pkt) => {
					if (this._isPacketCoveredByAck(ackPacketId, pkt.packetId)) {
						ackedCommands.push({
							packetId: pkt.packetId,
							trackingId: pkt.trackingId,
						})
						return false
					} else {
						// Not acked yet
						return true
					}
				})
				ps.push(this.onCommandsAcknowledged(ackedCommands))
				// this.log(`${Date.now()} Got ack ${ackPacketId} Remaining=${this._inFlight.length}`)
			}
		}

		Promise.all(ps).catch((e) => {
			this.log(`Failed to receivePacket: ${e?.message ?? e}`)
		})
	}

	private _sendPacket(packet: Buffer): void {
		if (this._debugBuffers) this.log(`SEND ${packet.toString('hex')}`)
		this._socket.send(packet, 0, packet.length, this._port, this._address)
	}

	private _sendOrQueueAck(): void {
		this._receivedWithoutAck++
		if (this._receivedWithoutAck >= MAX_PACKET_PER_ACK) {
			this._receivedWithoutAck = 0
			this._ackTimerRunning = false
			this._ackTimer.clearTimeout()
			this._sendAck(this._lastReceivedPacketId)
		} else if (!this._ackTimerRunning) {
			this._ackTimerRunning = true
			// timeout for 5 ms (syntax for nanotimer says m)
			this._ackTimer.setTimeout(
				() => {
					this._receivedWithoutAck = 0
					this._ackTimerRunning = false
					this._sendAck(this._lastReceivedPacketId)
				},
				[],
				'5m'
			)
		}
	}

	private _sendAck(packetId: number): void {
		const opcode = PacketFlag.AckReply << 11
		const length = 12
		const buffer = Buffer.alloc(length, 0)
		buffer.writeUInt16BE(opcode | length, 0)
		buffer.writeUInt16BE(this._sessionId, 2)
		buffer.writeUInt16BE(packetId, 4)
		this._sendPacket(buffer)
	}

	private async _retransmitFrom(fromId: number): Promise<void> {
		// this.log(`Resending from ${fromId} to ${this._inFlight.length > 0 ? this._inFlight[this._inFlight.length - 1].packetId : '-'}`)

		// The atem will ask for MAX_PACKET_ID to be retransmitted when it really wants 0
		fromId = fromId % MAX_PACKET_ID

		const fromIndex = this._inFlight.findIndex((pkt) => pkt.packetId === fromId)
		if (fromIndex === -1) {
			// fromId is not inflight, so we cannot resend. only fix is to abort
			this.log(`Unable to resend: ${fromId}`)
			await this.restartConnection()
		} else {
			this.log(`Resending from ${fromId} to ${this._inFlight[this._inFlight.length - 1].packetId}`)
			// Resend from the requested
			for (let i = fromIndex; i < this._inFlight.length; i++) {
				const sentPacket = this._inFlight[i]
				if (sentPacket.packetId === fromId || !this._isPacketCoveredByAck(fromId, sentPacket.packetId)) {
					sentPacket.lastSent = Date.now()
					sentPacket.resent++

					// this.log(`${Date.now()} Resending ${sentPacket.packetId} Last=${this._nextSendPacketId - 1}`)
					this._sendPacket(sentPacket.payload)
				}
			}
		}
	}

	private async _checkForRetransmit(): Promise<void> {
		for (const sentPacket of this._inFlight) {
			if (sentPacket.lastSent + IN_FLIGHT_TIMEOUT < Date.now()) {
				if (
					sentPacket.resent <= MAX_PACKET_RETRIES &&
					this._isPacketCoveredByAck(this._nextSendPacketId, sentPacket.packetId)
				) {
					this.log(`Retransmit from timeout: ${sentPacket.packetId}`)
					// Retransmit the packet and anything after it
					return this._retransmitFrom(sentPacket.packetId)
				} else {
					// A command has timed out, so we need to reset to avoid getting stuck
					this.log(`Packet timed out: ${sentPacket.packetId}`)
					return this.restartConnection()
				}
			}
		}

		return Promise.resolve()
	}
}
