const mediaType = {
  audio: 'audioType',
  video: 'videoType'
}
const _EVENTS = {
  exitRoom: 'exitRoom',
  openRoom: 'openRoom',
  startVideo: 'startVideo',
  stopVideo: 'stopVideo',
  startAudio: 'startAudio',
  stopAudio: 'stopAudio'
}

class RoomClient {
  constructor(localMediaEl, remoteVideoEl, remoteAudioEl, mediasoupClient, socket, room_id, name, successCallback, options = {}) {
    this.name = name
    this.localMediaEl = localMediaEl
    this.remoteVideoEl = remoteVideoEl
    this.remoteAudioEl = remoteAudioEl
    this.mediasoupClient = mediasoupClient

    this.socket = socket
    this.producerTransport = null
    this.consumerTransport = null
    this.device = null
    this.room_id = room_id

    this.isVideoOnFullScreen = false
    this.isDevicesVisible = false

    this.consumers = new Map()
    this.producers = new Map()
    this.peerCardsById = new Map()
    this.consumerOwner = new Map()
    this.localCard = null
    this.isTrainer = !!options.isTrainer
    this.profilePic = options.profilePic || null

    console.log('Mediasoup client', mediasoupClient)

    /**
     * map that contains a mediatype as key and producer_id as value
     */
    this.producerLabel = new Map()

    this._isOpen = false
    this.eventListeners = new Map()

    Object.keys(_EVENTS).forEach(
      function (evt) {
        this.eventListeners.set(evt, [])
      }.bind(this)
    )

    this.createRoom(room_id).then(
      async function () {
        await this.join(name, room_id)
        this.initSockets()
        this._isOpen = true
        successCallback()
      }.bind(this)
    )
  }

  ////////// INIT /////////

  async createRoom(room_id) {
    await this.socket
      .request('createRoom', {
        room_id
      })
      .catch((err) => {
        console.log('Create room error:', err)
      })
  }

  async join(name, room_id) {
    try {
      const e = await this.socket.request('join', {
        name,
        room_id,
        avatar: this.profilePic,
        isTrainer: this.isTrainer
      })
      console.log('Joined to room', e)

      const data = await this.socket.request('getRouterRtpCapabilities')
      const device = await this.loadDevice(data)
      this.device = device
      await this.initTransports(device)
      await this.initializeParticipants()
      this.socket.emit('getProducers')
    } catch (err) {
      console.log('Join error:', err)
    }
  }

  async loadDevice(routerRtpCapabilities) {
    let device
    try {
      device = new this.mediasoupClient.Device()
    } catch (error) {
      if (error.name === 'UnsupportedError') {
        console.error('Browser not supported')
        alert('Browser not supported')
      }
      console.error(error)
    }
    await device.load({
      routerRtpCapabilities
    })
    return device
  }

  async initTransports(device) {
    // init producerTransport
    {
      const data = await this.socket.request('createWebRtcTransport', {
        forceTcp: false,
        rtpCapabilities: device.rtpCapabilities
      })

      if (data.error) {
        console.error(data.error)
        return
      }

      this.producerTransport = device.createSendTransport(data)

      this.producerTransport.on(
        'connect',
        async function ({ dtlsParameters }, callback, errback) {
          this.socket
            .request('connectTransport', {
              dtlsParameters,
              transport_id: data.id
            })
            .then(callback)
            .catch(errback)
        }.bind(this)
      )

      this.producerTransport.on(
        'produce',
        async function ({ kind, rtpParameters }, callback, errback) {
          try {
            const { producer_id } = await this.socket.request('produce', {
              producerTransportId: this.producerTransport.id,
              kind,
              rtpParameters
            })
            callback({
              id: producer_id
            })
          } catch (err) {
            errback(err)
          }
        }.bind(this)
      )

      this.producerTransport.on(
        'connectionstatechange',
        function (state) {
          switch (state) {
            case 'connecting':
              break

            case 'connected':
              //localVideo.srcObject = stream
              break

            case 'failed':
              this.producerTransport.close()
              break

            default:
              break
          }
        }.bind(this)
      )
    }

    // init consumerTransport
    {
      const data = await this.socket.request('createWebRtcTransport', {
        forceTcp: false
      })

      if (data.error) {
        console.error(data.error)
        return
      }

      // only one needed
      this.consumerTransport = device.createRecvTransport(data)
      this.consumerTransport.on(
        'connect',
        function ({ dtlsParameters }, callback, errback) {
          this.socket
            .request('connectTransport', {
              transport_id: this.consumerTransport.id,
              dtlsParameters
            })
            .then(callback)
            .catch(errback)
        }.bind(this)
      )

      this.consumerTransport.on(
        'connectionstatechange',
        async function (state) {
          switch (state) {
            case 'connecting':
              break

            case 'connected':
              //remoteVideo.srcObject = await stream;
              //await socket.request('resume');
              break

            case 'failed':
              this.consumerTransport.close()
              break

            default:
              break
          }
        }.bind(this)
      )
    }
  }

  initSockets() {
    this.socket.on(
      'consumerClosed',
      function ({ consumer_id }) {
        console.log('Closing consumer:', consumer_id)
        this.removeConsumer(consumer_id)
      }.bind(this)
    )

    /**
     * data: [ {
     *  producer_id:
     *  producer_socket_id:
     * }]
     */
    this.socket.on(
      'newProducers',
      async function (data) {
        console.log('New producers', data)
        for (let { producer_id, producer_socket_id } of data) {
          await this.consume(producer_id, producer_socket_id)
        }
      }.bind(this)
    )

    // Keep participant cards in sync with join/leave events
    this.socket.on(
      'peerJoined',
      function ({ name, socketId, avatar, isTrainer }) {
        if (!socketId || !name || name === this.name) return
        this.createOrGetRemoteCard(socketId, name, avatar, isTrainer)
      }.bind(this)
    )

    this.socket.on(
      'peerLeft',
      function ({ socketId }) {
        if (!socketId) return
        const card = this.peerCardsById.get(socketId)
        if (card && card.parentNode) {
          card.parentNode.removeChild(card)
        }
        this.peerCardsById.delete(socketId)

        // Add smooth fade-out animation
        if (card) {
          card.classList.add('removing')
          setTimeout(() => {
            if (card.parentNode) {
              card.parentNode.removeChild(card)
            }
            // Update layout after removal
            if (window.updateGridLayout) {
              window.updateGridLayout()
            } else {
              this.updateGridLayout()
            }
          }, 300)
        } else {
          if (window.updateGridLayout) {
            window.updateGridLayout()
          } else {
            this.updateGridLayout()
          }
        }
      }.bind(this)
    )

    // Trainer/owner moderation events
    this.socket.on(
      'forceMute',
      function ({ by }) {
        console.log('Force mute received from', by)
        // Close local audio producer if present
        if (this.producerLabel && this.producerLabel.has(mediaType.audio)) {
          this.closeProducer(mediaType.audio)
        }
        if (window.showNotification) {
          window.showNotification(`${by || 'Trainer'} muted your microphone`)
        }

        // If the participants list is currently open, refresh it so that
        // our own mic status updates there as well.
        try {
          if (
            typeof window.openParticipantsModal === 'function' &&
            typeof participantsModal !== 'undefined' &&
            !participantsModal.classList.contains('hidden')
          ) {
            window.openParticipantsModal()
          }
        } catch (e) {
          console.warn('Failed to refresh participants list after force mute:', e)
        }
      }.bind(this)
    )

    this.socket.on(
      'requestUnmute',
      function ({ by }) {
        console.log('Request unmute received from', by)
        if (window.showNotification) {
          window.showNotification(`${by || 'Trainer'} asked you to unmute your microphone`)
        }
      }.bind(this)
    )

    this.socket.on(
      'disconnect',
      function () {
        this.exit(true)
      }.bind(this)
    )
  }

  //////// MAIN FUNCTIONS /////////////

  async produce(type, deviceId = null) {
    // Ensure device and transports are ready before trying to produce
    if (!this.device) {
      console.error('Cannot produce: mediasoup device is not initialized yet')
      return
    }
    if (!this.producerTransport) {
      console.error('Cannot produce: producer transport is not initialized yet')
      return
    }

    let mediaConstraints = {}
    let audio = false
    switch (type) {
      case mediaType.audio:
        mediaConstraints = {
          audio: {
            deviceId: deviceId
          },
          video: false
        }
        audio = true
        break
      case mediaType.video:
        mediaConstraints = {
          audio: false,
          video: {
            width: {
              min: 640,
              ideal: 1920
            },
            height: {
              min: 400,
              ideal: 1080
            },
            deviceId: deviceId
            /*aspectRatio: {
                            ideal: 1.7777777778
                        }*/
          }
        }
        break
      default:
        return
    }
    if (!this.device.canProduce('video') && !audio) {
      console.error('Cannot produce video')
      return
    }
    if (this.producerLabel.has(type)) {
      console.log('Producer already exists for this type ' + type)
      return
    }
    console.log('Mediacontraints:', mediaConstraints)
    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia(mediaConstraints)
      console.log(navigator.mediaDevices.getSupportedConstraints())

      const track = audio ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0]
      const params = {
        // Keep it simple: let the browser/mediasoup decide encodings to avoid
        // SDP/recv-parameter incompatibility errors in some browsers.
        track
      }
      producer = await this.producerTransport.produce(params)

      console.log('Producer', producer)

      this.producers.set(producer.id, producer)

      let elem
      if (!audio) {
        const card = this.ensureLocalCard()
        elem = card.querySelector('video')
        if (!elem) {
          elem = document.createElement('video')
          elem.playsinline = false
          elem.autoplay = true
          elem.className = 'vid hidden'
          card.appendChild(elem)
        }
        elem.srcObject = stream
        elem.id = producer.id
        elem.classList.remove('hidden')
        const placeholder = card.querySelector('.participant-placeholder')
        if (placeholder) placeholder.classList.add('hidden')
        this.handleFS(elem.id)
      }

      producer.on('trackended', () => {
        this.closeProducer(type)
      })

      producer.on('transportclose', () => {
        console.log('Producer transport close')
        if (!audio) {
          elem.srcObject.getTracks().forEach(function (track) {
            track.stop()
          })
          elem.parentNode.removeChild(elem)
        }
        this.producers.delete(producer.id)
      })

      producer.on('close', () => {
        console.log('Closing producer')
        if (!audio) {
          elem.srcObject.getTracks().forEach(function (track) {
            track.stop()
          })
          elem.parentNode.removeChild(elem)
        }
        this.producers.delete(producer.id)
      })

      this.producerLabel.set(type, producer.id)

      switch (type) {
        case mediaType.audio:
          this.event(_EVENTS.startAudio)
          break
        case mediaType.video:
          this.event(_EVENTS.startVideo)
          break
        default:
          return
      }
    } catch (err) {
      console.log('Produce error:', err)
    }
  }

  async consume(producer_id, ownerSocketId = null) {
    // Forward to extended version so we can attach video into the correct card.
    return this.consumeForOwner(producer_id, ownerSocketId)
  }

  /**
   * Consume a producer and, if it's video, attach it into the appropriate
   * participant card.
   */
  async consumeForOwner(producer_id, ownerSocketId = null) {
    this.getConsumeStream(producer_id).then(
      function ({ consumer, stream, kind }) {
        this.consumers.set(consumer.id, consumer)

        let elem
        if (kind === 'video') {
          let card = null
          if (ownerSocketId && this.peerCardsById.has(ownerSocketId)) {
            card = this.peerCardsById.get(ownerSocketId)
          }

          if (card) {
            elem = card.querySelector('video')
            if (!elem) {
              elem = document.createElement('video')
              elem.playsinline = false
              elem.autoplay = true
              elem.className = 'vid hidden'
              card.appendChild(elem)
            }
            elem.srcObject = stream
            elem.id = consumer.id
            elem.classList.remove('hidden')
            const placeholder = card.querySelector('.participant-placeholder')
            if (placeholder) placeholder.classList.add('hidden')
            this.handleFS(elem.id)
          } else {
            // Fallback: attach directly if we don't have a card
            elem = document.createElement('video')
            elem.srcObject = stream
            elem.id = consumer.id
            elem.playsinline = false
            elem.autoplay = true
            elem.className = 'vid'
            this.remoteVideoEl.appendChild(elem)
            this.handleFS(elem.id)
          }

          this.consumerOwner.set(consumer.id, ownerSocketId)
        } else {
          elem = document.createElement('audio')
          elem.srcObject = stream
          elem.id = consumer.id
          elem.playsinline = false
          elem.autoplay = true
          this.remoteAudioEl.appendChild(elem)
        }

        consumer.on(
          'trackended',
          function () {
            this.removeConsumer(consumer.id)
          }.bind(this)
        )

        consumer.on(
          'transportclose',
          function () {
            this.removeConsumer(consumer.id)
          }.bind(this)
        )
      }.bind(this)
    )
  }

  async getConsumeStream(producerId) {
    const { rtpCapabilities } = this.device
    const data = await this.socket.request('consume', {
      rtpCapabilities,
      consumerTransportId: this.consumerTransport.id, // might be
      producerId
    })
    const { id, kind, rtpParameters } = data

    let codecOptions = {}
    const consumer = await this.consumerTransport.consume({
      id,
      producerId,
      kind,
      rtpParameters,
      codecOptions
    })

    const stream = new MediaStream()
    stream.addTrack(consumer.track)

    return {
      consumer,
      stream,
      kind
    }
  }

  closeProducer(type) {
    if (!this.producerLabel.has(type)) {
      console.log('There is no producer for this type ' + type)
      return
    }

    let producer_id = this.producerLabel.get(type)
    console.log('Close producer', producer_id)

    this.socket.emit('producerClosed', {
      producer_id
    })

    this.producers.get(producer_id).close()
    this.producers.delete(producer_id)
    this.producerLabel.delete(type)

    if (type !== mediaType.audio) {
      let elem = document.getElementById(producer_id)
      if (elem && elem.srcObject) {
        elem.srcObject.getTracks().forEach(function (track) {
          track.stop()
        })
        elem.srcObject = null
      }
      if (elem) {
        elem.classList.add('hidden')
        const card = elem.parentNode
        if (card) {
          const placeholder = card.querySelector('.participant-placeholder')
          if (placeholder) placeholder.classList.remove('hidden')
        }
      }
    }

    switch (type) {
      case mediaType.audio:
        this.event(_EVENTS.stopAudio)
        break
      case mediaType.video:
        this.event(_EVENTS.stopVideo)
        break
      default:
        return
    }
  }

  pauseProducer(type) {
    if (!this.producerLabel.has(type)) {
      console.log('There is no producer for this type ' + type)
      return
    }

    let producer_id = this.producerLabel.get(type)
    this.producers.get(producer_id).pause()
  }

  resumeProducer(type) {
    if (!this.producerLabel.has(type)) {
      console.log('There is no producer for this type ' + type)
      return
    }

    let producer_id = this.producerLabel.get(type)
    this.producers.get(producer_id).resume()
  }

  removeConsumer(consumer_id) {
    let elem = document.getElementById(consumer_id)
    if (elem && elem.srcObject) {
      elem.srcObject.getTracks().forEach(function (track) {
        track.stop()
      })
      elem.srcObject = null
    }
    if (elem) {
      elem.classList.add('hidden')
      const card = elem.parentNode
      if (card) {
        const placeholder = card.querySelector('.participant-placeholder')
        if (placeholder) placeholder.classList.remove('hidden')
      }
    }

    this.consumers.delete(consumer_id)
    this.consumerOwner.delete(consumer_id)
  }

  exit(offline = false) {
    let clean = function () {
      this._isOpen = false
      this.consumerTransport.close()
      this.producerTransport.close()
      this.socket.off('disconnect')
      this.socket.off('newProducers')
      this.socket.off('consumerClosed')
    }.bind(this)

    if (!offline) {
      this.socket
        .request('exitRoom')
        .then((e) => console.log(e))
        .catch((e) => console.warn(e))
        .finally(
          function () {
            clean()
          }.bind(this)
        )
    } else {
      clean()
    }

    this.event(_EVENTS.exitRoom)
  }

  ///////  HELPERS //////////
  async initializeParticipants() {
    // Always ensure we have our own card
    const localCard = this.ensureLocalCard()

    try {
      const info = await this.roomInfo()
      if (info && info.peers) {
        const peersArr = JSON.parse(info.peers)
        peersArr.forEach(([socketId, peer]) => {
          if (!peer || !peer.name) return
          if (peer.name === this.name) {
            // Map our own socket id to the local card
            this.peerCardsById.set(socketId, localCard)
          } else {
            this.createOrGetRemoteCard(socketId, peer.name, peer.avatar, peer.isTrainer)
          }
        })
      }
    } catch (e) {
      console.warn('Failed to initialize participant cards', e)
    }

    this.updateGridLayout()
  }

  ensureLocalCard() {
    if (this.localCard) return this.localCard
    const card = document.createElement('div')
    card.className = 'video-card'
    card.dataset.participantType = 'local'

    const placeholder = document.createElement('div')
    placeholder.className =
      'participant-placeholder flex flex-col items-center justify-center text-white text-sm gap-1'

    const avatar = document.createElement('div')
    avatar.className =
      'w-12 h-12 rounded-full bg-gray-700 flex items-center justify-center text-lg font-semibold'
    if (this.profilePic) {
      avatar.style.backgroundImage = `url('${this.profilePic}')`
      avatar.style.backgroundSize = 'cover'
      avatar.style.backgroundPosition = 'center'
      avatar.textContent = ''
    } else {
      const initial = (this.name && this.name[0] && this.name[0].toUpperCase()) || 'U'
      avatar.textContent = initial
    }

    const nameEl = document.createElement('div')
    nameEl.className = 'font-medium'
    nameEl.textContent = `${this.name || 'You'} (You)`

    placeholder.appendChild(avatar)
    placeholder.appendChild(nameEl)
    card.appendChild(placeholder)

    if (this.isTrainer) {
      const badge = document.createElement('div')
      badge.className = 'trainer-badge'
      badge.textContent = 'Trainer'
      card.appendChild(badge)
    }

    // Hidden video element to be used when video is ON
    const video = document.createElement('video')
    video.playsinline = false
    video.autoplay = true
    video.className = 'vid hidden'
    card.appendChild(video)

    this.localMediaEl.appendChild(card)
    this.localCard = card

    // Add pin icon button
    if (typeof addPinButtonToCard === 'function') {
      addPinButtonToCard(card)
    }
    
    // Allow pinning by clicking the card
    card.style.cursor = 'pointer'
    card.addEventListener('click', (e) => {
      // Don't pin if clicking the pin button itself
      if (e.target.closest('.pin-button')) return
      if (window.setPinnedCard) {
        window.setPinnedCard(card)
      }
    })
    this.updateGridLayout()
    return card
  }

  createOrGetRemoteCard(socketId, name, profilePicUrl = null, isTrainer = false) {
    if (!socketId) return null
    if (this.peerCardsById.has(socketId)) {
      return this.peerCardsById.get(socketId)
    }

    const card = document.createElement('div')
    card.className = 'video-card'
    card.dataset.participantId = socketId

    const placeholder = document.createElement('div')
    placeholder.className =
      'participant-placeholder flex flex-col items-center justify-center text-white text-sm gap-1'

    const avatar = document.createElement('div')
    avatar.className =
      'w-12 h-12 rounded-full bg-gray-700 flex items-center justify-center text-lg font-semibold'

    if (profilePicUrl) {
      avatar.style.backgroundImage = `url('${profilePicUrl}')`
      avatar.style.backgroundSize = 'cover'
      avatar.style.backgroundPosition = 'center'
      avatar.textContent = ''
    } else {
      const initial = (name && name[0] && name[0].toUpperCase()) || 'P'
      avatar.textContent = initial
    }

    const nameEl = document.createElement('div')
    nameEl.className = 'font-medium'
    nameEl.textContent = name || 'Participant'

    placeholder.appendChild(avatar)
    placeholder.appendChild(nameEl)
    card.appendChild(placeholder)

    if (isTrainer) {
      const badge = document.createElement('div')
      badge.className = 'trainer-badge'
      badge.textContent = 'Trainer'
      card.appendChild(badge)
    }

    // Hidden video element to be used when video is ON
    const video = document.createElement('video')
    video.playsinline = false
    video.autoplay = true
    video.className = 'vid hidden'
    card.appendChild(video)

    this.remoteVideoEl.appendChild(card)
    this.peerCardsById.set(socketId, card)

    // Add pin icon button
    if (typeof addPinButtonToCard === 'function') {
      addPinButtonToCard(card)
    }
    
    // Allow pinning by clicking the card
    card.style.cursor = 'pointer'
    card.addEventListener('click', (e) => {
      // Don't pin if clicking the pin button itself
      if (e.target.closest('.pin-button')) return
      if (window.setPinnedCard) {
        window.setPinnedCard(card)
      }
    })

    this.updateGridLayout()
    return card
  }

  async roomInfo() {
    let info = await this.socket.request('getMyRoomInfo')
    return info
  }

  updateGridLayout() {
    // Use the global updateGridLayout function if available
    if (window.updateGridLayout) {
      window.updateGridLayout()
      return
    }

    // Fallback to simple layout
    const grid = this.localMediaEl
    if (!grid) return
    const cards = grid.querySelectorAll('.video-card')
    const count = cards.length

    grid.classList.remove('layout-3', 'layout-4')

    if (count === 3) {
      grid.classList.add('layout-3')
    } else if (count === 4) {
      grid.classList.add('layout-4')
    }
  }

  static get mediaType() {
    return mediaType
  }

  event(evt) {
    if (this.eventListeners.has(evt)) {
      this.eventListeners.get(evt).forEach((callback) => callback())
    }
  }

  on(evt, callback) {
    this.eventListeners.get(evt).push(callback)
  }

  //////// GETTERS ////////

  isOpen() {
    return this._isOpen
  }

  static get EVENTS() {
    return _EVENTS
  }

  //////// UTILITY ////////

  showDevices() {
    if (!this.isDevicesVisible) {
      reveal(devicesList)
      this.isDevicesVisible = true
    } else {
      hide(devicesList)
      this.isDevicesVisible = false
    }
  }

  handleFS(id) {
    let videoPlayer = document.getElementById(id)
    videoPlayer.addEventListener('fullscreenchange', (e) => {
      if (videoPlayer.controls) return
      let fullscreenElement = document.fullscreenElement
      if (!fullscreenElement) {
        videoPlayer.style.pointerEvents = 'auto'
        this.isVideoOnFullScreen = false
      }
    })
    videoPlayer.addEventListener('webkitfullscreenchange', (e) => {
      if (videoPlayer.controls) return
      let webkitIsFullScreen = document.webkitIsFullScreen
      if (!webkitIsFullScreen) {
        videoPlayer.style.pointerEvents = 'auto'
        this.isVideoOnFullScreen = false
      }
    })
    videoPlayer.addEventListener('click', (e) => {
      if (videoPlayer.controls) return
      if (!this.isVideoOnFullScreen) {
        if (videoPlayer.requestFullscreen) {
          videoPlayer.requestFullscreen()
        } else if (videoPlayer.webkitRequestFullscreen) {
          videoPlayer.webkitRequestFullscreen()
        } else if (videoPlayer.msRequestFullscreen) {
          videoPlayer.msRequestFullscreen()
        }
        this.isVideoOnFullScreen = true
        videoPlayer.style.pointerEvents = 'none'
      } else {
        if (document.exitFullscreen) {
          document.exitFullscreen()
        } else if (document.webkitCancelFullScreen) {
          document.webkitCancelFullScreen()
        } else if (document.msExitFullscreen) {
          document.msExitFullscreen()
        }
        this.isVideoOnFullScreen = false
        videoPlayer.style.pointerEvents = 'auto'
      }
    })
  }
}
