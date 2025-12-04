if (location.href.substr(0, 5) !== 'https') location.href = 'https' + location.href.substr(4, location.href.length - 4)

const socket = io()

let producer = null
let lobbyPreviewStream = null
let lobbyAudioDeviceId = null
let lobbyVideoDeviceId = null

nameInput.value = 'user_' + Math.round(Math.random() * 1000)

socket.request = function request(type, data = {}) {
  return new Promise((resolve, reject) => {
    socket.emit(type, data, (data) => {
      if (data.error) {
        reject(data.error)
      } else {
        resolve(data)
      }
    })
  })
}

// Global notifications for room events
socket.on('peerJoined', ({ name }) => {
  const displayName = name || 'Someone'
  showNotification(`${displayName} joined the call`)
})

socket.on('peerLeft', ({ name }) => {
  const displayName = name || 'Someone'
  showNotification(`${displayName} left the call`)
})

// Derive room id from URL path: /<room_id>
const pathParts = window.location.pathname.split('/').filter(Boolean)
const roomFromUrl = pathParts[0] || '123'
if (typeof roomidInput !== 'undefined') {
  roomidInput.value = roomFromUrl
}

const API_BASE_URL = 'https://prana.ycp.life/api/v1'

let authToken = null
let currentUserProfile = null
let currentSessionId = null
let currentAttendanceId = null
let currentRoomId = roomFromUrl
let currentDisplayName = null
let isTrainerFlag = '0'
let rc = null
let didAudioWarmup = false
let pinnedCard = null

// === Generic Video Grid UI API (no backend/WebRTC logic) ===
const GRID_CONTAINER_ID = 'videoGrid'

function getGridContainer() {
  return document.getElementById(GRID_CONTAINER_ID)
}

function getUserCard(id) {
  const grid = getGridContainer()
  if (!grid) return null
  return grid.querySelector(`.video-card[data-user-id="${id}"]`)
}

// Create a participant card with avatar, name and hidden video element
window.createUserCard = function (id, name, avatar) {
  const grid = getGridContainer()
  if (!grid || !id) return
  if (getUserCard(id)) return

  const card = document.createElement('div')
  card.className = 'video-card'
  card.dataset.userId = id

  const placeholder = document.createElement('div')
  placeholder.className =
    'participant-placeholder flex flex-col items-center justify-center text-white text-sm gap-1'

  const avatarEl = document.createElement('div')
  avatarEl.className =
    'w-12 h-12 rounded-full bg-gray-700 flex items-center justify-center text-lg font-semibold'
  if (avatar && avatar.length > 0) {
    avatarEl.textContent = avatar[0].toUpperCase()
  } else if (name && name.length > 0) {
    avatarEl.textContent = name[0].toUpperCase()
  } else {
    avatarEl.textContent = 'U'
  }

  const nameEl = document.createElement('div')
  nameEl.className = 'font-medium'
  nameEl.textContent = name || 'Participant'

  placeholder.appendChild(avatarEl)
  placeholder.appendChild(nameEl)
  card.appendChild(placeholder)

  const video = document.createElement('video')
  video.playsinline = true
  video.autoplay = true
  video.className = 'vid hidden'
  card.appendChild(video)

  grid.appendChild(card)

  // Allow pinning
  card.addEventListener('click', () => {
    if (window.setPinnedCard) {
      window.setPinnedCard(card)
    }
  })

  window.updateGridLayout()
}

// Attach a MediaStream to a user's card and show the video
window.attachStream = function (id, stream) {
  const card = getUserCard(id)
  if (!card) return
  const video = card.querySelector('video')
  const placeholder = card.querySelector('.participant-placeholder')
  if (!video) return

  try {
    video.srcObject = stream
  } catch {
    video.srcObject = null
  }
  video.classList.remove('hidden')
  if (placeholder) placeholder.classList.add('hidden')

  // Update layout when video starts
  setTimeout(() => {
    window.updateGridLayout()
  }, 100)
}

// Detach the video stream and show avatar/name instead
window.detachStream = function (id) {
  const card = getUserCard(id)
  if (!card) return
  const video = card.querySelector('video')
  const placeholder = card.querySelector('.participant-placeholder')
  if (!video) return

  if (video.srcObject && video.srcObject.getTracks) {
    video.srcObject.getTracks().forEach((track) => track.stop())
  }
  video.srcObject = null
  video.classList.add('hidden')
  if (placeholder) placeholder.classList.remove('hidden')

  // Update layout when video stops
  setTimeout(() => {
    window.updateGridLayout()
  }, 100)
}

// Screen size detection
function getScreenSize() {
  const width = window.innerWidth
  if (width <= 640) return 'mobile'
  if (width <= 768) return 'tablet'
  if (width <= 1024) return 'small-desktop'
  return 'large-desktop'
}

// Get participant count (excluding pinned)
function getParticipantCount() {
  const grid = getGridContainer()
  if (!grid) return 0
  const pinnedContainer = pinnedContainerEl()
  const pinnedCards = pinnedContainer && !pinnedContainer.classList.contains('hidden')
    ? pinnedContainer.querySelectorAll('.video-card').length
    : 0
  const allCards = grid.querySelectorAll('.video-card').length
  return allCards - pinnedCards
}

// Recalculate layout based on screen size and participant count
window.updateGridLayout = function (count) {
  const grid = getGridContainer()
  if (!grid) return

  const cards = Array.from(grid.querySelectorAll('.video-card'))
  const n = typeof count === 'number' ? count : getParticipantCount()
  const screenSize = getScreenSize()
  const pinnedContainer = pinnedContainerEl()
  const hasPinned = pinnedContainer && !pinnedContainer.classList.contains('hidden') && pinnedContainer.querySelector('.video-card')

  // Remove all layout classes
  grid.classList.remove(
    'layout-1', 'layout-2', 'layout-3', 'layout-4',
    'layout-5', 'layout-6', 'layout-7', 'layout-8', 'layout-9',
    'layout-10', 'layout-11', 'layout-12', 'layout-13', 'layout-14', 'layout-15', 'layout-16',
    'layout-17plus', 'layout-5plus', 'layout-5plus-scroll',
    'layout-pinned', 'layout-pinned-mobile'
  )

  // Handle pinned video layouts
  if (hasPinned) {
    if (screenSize === 'mobile') {
      grid.classList.add('layout-pinned-mobile')
    } else {
      grid.classList.add('layout-pinned')
    }
    return
  }

  // Auto-pin on mobile if 5+ participants
  if (screenSize === 'mobile' && n > 4) {
    const firstCard = cards[0]
    if (firstCard && window.setPinnedCard) {
      window.setPinnedCard(firstCard)
      return
    }
  }

  // Apply layout based on screen size and participant count
  if (screenSize === 'mobile') {
    // Mobile layouts
    if (n === 1 || n === 2) {
      grid.classList.add(n === 1 ? 'layout-1' : 'layout-2')
    } else if (n === 3 || n === 4) {
      grid.classList.add('layout-4')
    } else {
      // 5+ participants: pinned + scrollable
      grid.classList.add('layout-5plus')
      // Create scrollable container if it doesn't exist
      let scrollContainer = grid.querySelector('.layout-5plus-scroll')
      if (!scrollContainer) {
        scrollContainer = document.createElement('div')
        scrollContainer.className = 'layout-5plus-scroll'
        // Move all cards except first to scroll container
        cards.slice(1).forEach(card => {
          scrollContainer.appendChild(card)
        })
        grid.appendChild(scrollContainer)
      }
    }
  } else if (screenSize === 'tablet') {
    // Tablet layouts
    if (n === 1) {
      grid.classList.add('layout-1')
    } else if (n === 2) {
      grid.classList.add('layout-2')
    } else if (n === 3 || n === 4) {
      grid.classList.add('layout-4')
    } else {
      grid.classList.add('layout-5plus')
    }
  } else if (screenSize === 'small-desktop') {
    // Small desktop layouts
    if (n === 1) {
      grid.classList.add('layout-1')
    } else if (n === 2) {
      grid.classList.add('layout-2')
    } else if (n === 3) {
      grid.classList.add('layout-3')
    } else if (n === 4) {
      grid.classList.add('layout-4')
    } else {
      grid.classList.add('layout-5plus')
    }
  } else {
    // Large desktop layouts
    if (n === 1) {
      grid.classList.add('layout-1')
    } else if (n === 2) {
      grid.classList.add('layout-2')
    } else if (n === 3) {
      grid.classList.add('layout-3')
    } else if (n === 4) {
      grid.classList.add('layout-4')
    } else if (n === 5 || n === 6) {
      grid.classList.add(n === 5 ? 'layout-5' : 'layout-6')
    } else if (n === 7 || n === 8) {
      grid.classList.add(n === 7 ? 'layout-7' : 'layout-8')
    } else if (n === 9) {
      grid.classList.add('layout-9')
    } else if (n >= 10 && n <= 16) {
      grid.classList.add(`layout-${n}`)
    } else {
      grid.classList.add('layout-17plus')
    }
  }
}

// Reflow on resize with debounce
let resizeTimeout
window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout)
  resizeTimeout = setTimeout(() => {
    window.updateGridLayout()
  }, 150)
})

// === API helpers ===

function getAuthToken() {
  if (authToken) return authToken
  const params = new URLSearchParams(window.location.search)
  const fromUrl = params.get('token') || params.get('authToken')
  if (fromUrl) {
    localStorage.setItem('authToken', fromUrl)
    authToken = fromUrl
    return authToken
  }
  const stored = localStorage.getItem('authToken')
  if (stored) {
    authToken = stored
  }
  return authToken
}

function buildApiUrl(path) {
  if (!API_BASE_URL) return path
  return API_BASE_URL.replace(/\/+$/, '') + path
}

function authHeaders(includeJson = true) {
  const headers = {}
  const token = getAuthToken()
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  if (includeJson) {
    headers['Accept'] = 'application/json'
  }
  return headers
}

async function safeJsonFetch(url, options = {}) {
  try {
    const res = await fetch(url, options)
    if (!res.ok) {
      console.error('API error:', res.status, res.statusText)
      return null
    }
    const data = await res.json().catch(() => null)
    return data
  } catch (e) {
    console.error('API request failed:', e)
    return null
  }
}

async function fetchProfileIfNeeded() {
  if (currentUserProfile) return currentUserProfile
  const token = getAuthToken()
  if (!token) return null
  const url = buildApiUrl('/me/profile')
  const data = await safeJsonFetch(url, {
    method: 'GET',
    headers: authHeaders(true)
  })
  if (data) {
    // API response shape:
    // { success, message, data: { user_id, name, profile_pic, ... }, status_code }
    const profile = data.data || data
    currentUserProfile = profile
  }
  return currentUserProfile
}

async function initLobbyUserInfo() {
  try {
    const profile = await fetchProfileIfNeeded()

    let name = ''
    let avatarUrl = null

    if (profile) {
      name =
        profile.name ||
        profile.full_name ||
        profile.display_name ||
        profile.username ||
        profile.email ||
        ''

      avatarUrl =
        profile.profile_pic ||
        profile.profile_picture ||
        profile.avatar_url ||
        profile.avatar ||
        null
    }

    if (name && typeof nameInput !== 'undefined') {
      nameInput.value = name
    }

    if (typeof lobbyUserName !== 'undefined') {
      // Update the display name (username format)
      const username = name ? `@${name.toLowerCase().replace(/\s+/g, '')}` : '@user'
      lobbyUserName.textContent = username
    }

    const avatarEl = typeof lobbyUserAvatar !== 'undefined' ? lobbyUserAvatar : null
    if (avatarEl) {
      if (avatarUrl) {
        avatarEl.style.backgroundImage = `url('${avatarUrl}')`
        avatarEl.textContent = ''
      } else {
        avatarEl.style.backgroundImage = ''
        const initial = name && name[0] ? name[0].toUpperCase() : 'U'
        avatarEl.textContent = initial
      }
    }

    // Always show join card
    if (typeof lobbyJoinCard !== 'undefined') {
      lobbyJoinCard.classList.remove('hidden')
    }
  } catch (e) {
    console.error('Failed to init lobby user info:', e)
    // Show join card even if profile fetch fails
    if (typeof lobbyJoinCard !== 'undefined') {
      lobbyJoinCard.classList.remove('hidden')
    }
  }
}

function extractUserId(profile) {
  if (!profile) return null
  return profile.id || profile.user_id || profile.userId || null
}

function extractSessionId(data) {
  if (!data) return null
  return data.session_id || data.sessionId || data.id || null
}

function buildDeviceMetadata() {
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    screen: {
      width: window.screen && window.screen.width,
      height: window.screen && window.screen.height
    },
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight
    }
  }
}

function getDeviceName() {
  return navigator.platform || 'web'
}

async function checkOwnershipAndOngoing(roomId, displayName) {
  const token = getAuthToken()
  let sessionInfo = null
  isTrainerFlag = '0'

  if (token) {
    const profile = await fetchProfileIfNeeded()
    const userId = extractUserId(profile)

    if (userId) {
      const ownershipUrl = buildApiUrl(
        `/sessions/${encodeURIComponent(roomId)}/${encodeURIComponent(userId)}/check-ownership`
      )
      const ownership = await safeJsonFetch(ownershipUrl, {
        method: 'GET',
        headers: authHeaders(true)
      })

      if (ownership) {
        const payload = ownership.data || ownership
        const { is_owner, is_trainer_owner, is_institute_owner } = payload || {}
        if (is_owner || is_trainer_owner || is_institute_owner) {
          isTrainerFlag = '1'
          return { allowed: true, sessionInfo: null }
        }
      }
    }
  }

  // For non-trainers or anonymous users, check if session is ongoing
  const ongoingUrl = buildApiUrl(`/session-occurrences/session/${encodeURIComponent(roomId)}/ongoing`)
  const ongoing = await safeJsonFetch(ongoingUrl, {
    method: 'GET',
    headers: authHeaders(true)
  })

  if (!ongoing) {
    console.warn('Ongoing check failed; allowing join by default.')
    return { allowed: true, sessionInfo: null }
  }

  const isOngoing = ongoing.ongoing === true || ongoing.is_ongoing === true

  // if (!isOngoing) {
  //   showNotification('Session not started yet.')
  //   return { allowed: false, sessionInfo: null }
  // }

  sessionInfo = ongoing
  return { allowed: true, sessionInfo }
}

async function trackJoin(sessionId, displayName) {
  if (!sessionId) return null
  const url = buildApiUrl(`/attendances/session/${encodeURIComponent(sessionId)}/join`)
  const form = new FormData()
  form.append('name', displayName || '')
  form.append('device_name', getDeviceName())
  form.append('metadata', JSON.stringify(buildDeviceMetadata()))

  const headers = authHeaders(false)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: form
    })
    if (!res.ok) {
      console.error('Join tracking failed:', res.status, res.statusText)
      return null
    }
    const data = await res.json().catch(() => null)
    return data && (data.attendance_id || data.id)
  } catch (e) {
    console.error('Join tracking request failed:', e)
    return null
  }
}

async function trackLeave(sessionId, displayName, attendanceId, useKeepalive = false) {
  if (!sessionId || !attendanceId) return
  const url = buildApiUrl(`/attendances/session/${encodeURIComponent(sessionId)}/leave`)
  const form = new FormData()
  form.append('name', displayName || '')
  form.append('attendance_id', attendanceId)
  form.append('device_name', getDeviceName())
  form.append('timestamp', new Date().toISOString())
  form.append('metadata', JSON.stringify(buildDeviceMetadata()))

  const headers = authHeaders(false)

  try {
    await fetch(url, {
      method: 'POST',
      headers,
      body: form,
      keepalive: useKeepalive
    })
  } catch (e) {
    console.error('Leave tracking request failed:', e)
  }
}

// Initialize local media preview in the lobby
async function initLobbyPreview() {
  if (lobbyPreviewStream || typeof lobbyVideoPreview === 'undefined') return

  // Show lobby preview and placeholder initially
  if (typeof lobbyPreview !== 'undefined') {
    lobbyPreview.classList.remove('hidden')
  }
  if (typeof lobbyVideoPlaceholder !== 'undefined') {
    lobbyVideoPlaceholder.classList.remove('hidden')
    const placeholderText = typeof lobbyVideoPlaceholderText !== 'undefined' ? lobbyVideoPlaceholderText : null
    if (placeholderText) {
      placeholderText.textContent = 'Camera is off'
    }
  }
  if (typeof lobbyJoinCard !== 'undefined') {
    lobbyJoinCard.classList.remove('hidden')
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    if (typeof lobbyVideoPlaceholderText !== 'undefined') {
      lobbyVideoPlaceholderText.textContent = 'Camera/microphone preview not supported in this browser.'
    }
    return
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { width: { ideal: 1280 }, height: { ideal: 720 } }
    })
    lobbyPreviewStream = stream

    // Check if video track exists
    const videoTracks = stream.getVideoTracks()
    if (videoTracks.length > 0 && videoTracks[0].enabled) {
      lobbyVideoPreview.srcObject = stream
      lobbyVideoPreview.muted = true
      if (typeof lobbyVideoPreview !== 'undefined') {
        lobbyVideoPreview.classList.remove('hidden')
      }
      if (typeof lobbyVideoPlaceholder !== 'undefined') {
        lobbyVideoPlaceholder.classList.add('hidden')
      }
    } else {
      // No video track or video is disabled
      if (typeof lobbyVideoPlaceholder !== 'undefined') {
        lobbyVideoPlaceholder.classList.remove('hidden')
        if (typeof lobbyVideoPlaceholderText !== 'undefined') {
          lobbyVideoPlaceholderText.textContent = 'Camera is off'
        }
      }
      if (typeof lobbyVideoPreview !== 'undefined') {
        lobbyVideoPreview.classList.add('hidden')
      }
    }

    // Populate device dropdowns now that we have permission
    populateLobbyDevices()
  } catch (err) {
    console.error('Lobby preview failed:', err)
    if (typeof lobbyVideoPlaceholder !== 'undefined') {
      lobbyVideoPlaceholder.classList.remove('hidden')
      const placeholderText = typeof lobbyVideoPlaceholderText !== 'undefined' ? lobbyVideoPlaceholderText : null
      if (placeholderText) {
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          placeholderText.textContent = 'Camera/microphone access denied. Please allow access to continue.'
        } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
          placeholderText.textContent = 'No camera found. Please connect a camera device.'
        } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
          placeholderText.textContent = 'Camera is being used by another application.'
        } else {
          placeholderText.textContent = 'Unable to access camera. Please check your settings.'
        }
      }
    }
    if (typeof lobbyVideoPreview !== 'undefined') {
      lobbyVideoPreview.classList.add('hidden')
    }
  }
}

async function populateLobbyDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    if (typeof lobbyAudioSelect !== 'undefined') {
      lobbyAudioSelect.innerHTML = ''
    }
    if (typeof lobbyVideoSelect !== 'undefined') {
      lobbyVideoSelect.innerHTML = ''
    }
    if (typeof lobbySpeakerSelect !== 'undefined') {
      lobbySpeakerSelect.innerHTML = ''
    }

    devices.forEach((device) => {
      if (device.kind === 'audioinput' && typeof lobbyAudioSelect !== 'undefined') {
        const opt = document.createElement('option')
        opt.value = device.deviceId
        opt.textContent = device.label || 'Microphone'
        lobbyAudioSelect.appendChild(opt)
      }
      if (device.kind === 'videoinput' && typeof lobbyVideoSelect !== 'undefined') {
        const opt = document.createElement('option')
        opt.value = device.deviceId
        opt.textContent = device.label || 'Camera'
        lobbyVideoSelect.appendChild(opt)
      }
      if (device.kind === 'audiooutput' && typeof lobbySpeakerSelect !== 'undefined') {
        const opt = document.createElement('option')
        opt.value = device.deviceId
        opt.textContent = device.label || 'Speaker'
        lobbySpeakerSelect.appendChild(opt)
      }
    })
  } catch (e) {
    console.error('Failed to enumerate devices for lobby:', e)
  }
}

function toggleLobbyAudio() {
  if (!lobbyPreviewStream) return
  const audioTracks = lobbyPreviewStream.getAudioTracks()
  const enabled = audioTracks.some((t) => t.enabled)
  audioTracks.forEach((t) => {
    t.enabled = !enabled
  })
  if (typeof lobbyToggleAudio !== 'undefined') {
    const icon = lobbyToggleAudio.querySelector('i')
    if (icon) {
      if (!enabled) {
        icon.className = 'fas fa-microphone-slash'
      } else {
        icon.className = 'fas fa-microphone'
      }
    }
  }
}

function toggleLobbyVideo() {
  if (!lobbyPreviewStream) {
    // No stream available, show error
    if (typeof lobbyVideoPlaceholder !== 'undefined') {
      lobbyVideoPlaceholder.classList.remove('hidden')
      if (typeof lobbyVideoPlaceholderText !== 'undefined') {
        lobbyVideoPlaceholderText.textContent = 'Camera is off'
      }
    }
    if (typeof lobbyVideoPreview !== 'undefined') {
      lobbyVideoPreview.classList.add('hidden')
    }
    return
  }

  const videoTracks = lobbyPreviewStream.getVideoTracks()
  const enabled = videoTracks.some((t) => t.enabled)
  videoTracks.forEach((t) => {
    t.enabled = !enabled
  })

  if (typeof lobbyToggleVideo !== 'undefined') {
    const icon = lobbyToggleVideo.querySelector('i')
    if (icon) {
      if (!enabled) {
        icon.className = 'fas fa-video-slash'
        if (typeof lobbyVideoPreview !== 'undefined') {
          lobbyVideoPreview.classList.add('hidden')
        }
        if (typeof lobbyVideoPlaceholder !== 'undefined') {
          lobbyVideoPlaceholder.classList.remove('hidden')
          if (typeof lobbyVideoPlaceholderText !== 'undefined') {
            lobbyVideoPlaceholderText.textContent = 'Camera is off'
          }
        }
      } else {
        icon.className = 'fas fa-video'
        // Check if video track is actually available
        if (videoTracks.length > 0 && videoTracks[0].readyState === 'live') {
          if (typeof lobbyVideoPreview !== 'undefined') {
            lobbyVideoPreview.classList.remove('hidden')
          }
          if (typeof lobbyVideoPlaceholder !== 'undefined') {
            lobbyVideoPlaceholder.classList.add('hidden')
          }
        } else {
          // Video track not available
          if (typeof lobbyVideoPlaceholder !== 'undefined') {
            lobbyVideoPlaceholder.classList.remove('hidden')
            if (typeof lobbyVideoPlaceholderText !== 'undefined') {
              lobbyVideoPlaceholderText.textContent = 'No video available'
            }
          }
          if (typeof lobbyVideoPreview !== 'undefined') {
            lobbyVideoPreview.classList.add('hidden')
          }
        }
      }
    }
  }
}

async function refreshLobbyStream() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return

  const constraints = {
    audio: lobbyAudioDeviceId ? { deviceId: { exact: lobbyAudioDeviceId } } : true,
    video: lobbyVideoDeviceId
      ? { deviceId: { exact: lobbyVideoDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
      : { width: { ideal: 1280 }, height: { ideal: 720 } }
  }

  try {
    if (lobbyPreviewStream && lobbyPreviewStream.getTracks) {
      lobbyPreviewStream.getTracks().forEach((t) => t.stop())
    }
    const stream = await navigator.mediaDevices.getUserMedia(constraints)
    lobbyPreviewStream = stream
    if (typeof lobbyVideoPreview !== 'undefined') {
      lobbyVideoPreview.srcObject = stream
    }
  } catch (e) {
    console.error('Failed to refresh lobby stream with selected devices:', e)
  }
}

// Start lobby preview as soon as possible
document.addEventListener('DOMContentLoaded', () => {
  initLobbyPreview()
  initLobbyUserInfo()

  // Add error handler for video element
  if (typeof lobbyVideoPreview !== 'undefined') {
    lobbyVideoPreview.addEventListener('error', () => {
      if (typeof lobbyVideoPlaceholder !== 'undefined') {
        lobbyVideoPlaceholder.classList.remove('hidden')
        if (typeof lobbyVideoPlaceholderText !== 'undefined') {
          lobbyVideoPlaceholderText.textContent = 'Video failed to load'
        }
      }
      if (typeof lobbyVideoPreview !== 'undefined') {
        lobbyVideoPreview.classList.add('hidden')
      }
    })

    lobbyVideoPreview.addEventListener('loadedmetadata', () => {
      // Video loaded successfully
      const videoTracks = lobbyPreviewStream?.getVideoTracks() || []
      if (videoTracks.length === 0 || !videoTracks[0].enabled) {
        if (typeof lobbyVideoPlaceholder !== 'undefined') {
          lobbyVideoPlaceholder.classList.remove('hidden')
          if (typeof lobbyVideoPlaceholderText !== 'undefined') {
            lobbyVideoPlaceholderText.textContent = 'Camera is off'
          }
        }
        if (typeof lobbyVideoPreview !== 'undefined') {
          lobbyVideoPreview.classList.add('hidden')
        }
      }
    })
  }

  if (typeof lobbyToggleAudio !== 'undefined') {
    lobbyToggleAudio.addEventListener('click', toggleLobbyAudio)
  }
  if (typeof lobbyToggleVideo !== 'undefined') {
    lobbyToggleVideo.addEventListener('click', toggleLobbyVideo)
  }
  if (typeof lobbyAudioSelect !== 'undefined') {
    lobbyAudioSelect.addEventListener('change', (e) => {
      lobbyAudioDeviceId = e.target.value || null
      refreshLobbyStream()
    })
  }
  if (typeof lobbyVideoSelect !== 'undefined') {
    lobbyVideoSelect.addEventListener('change', (e) => {
      lobbyVideoDeviceId = e.target.value || null
      refreshLobbyStream()
    })
  }
  if (typeof lobbySpeakerSelect !== 'undefined') {
    lobbySpeakerSelect.addEventListener('change', (e) => {
      const deviceId = e.target.value
      setAudioOutputDevice(deviceId)
    })
  }
})

// Set audio output device for all audio elements
async function setAudioOutputDevice(deviceId) {
  if (!deviceId) return

  try {
    // Set sink for all audio elements in the page
    const audioElements = document.querySelectorAll('audio')
    for (const audio of audioElements) {
      if (audio.setSinkId) {
        await audio.setSinkId(deviceId)
      }
    }

    // Also set for remote audio container if it exists
    if (typeof remoteAudios !== 'undefined') {
      const remoteAudioElements = remoteAudios.querySelectorAll('audio')
      for (const audio of remoteAudioElements) {
        if (audio.setSinkId) {
          await audio.setSinkId(deviceId)
        }
      }
    }
  } catch (err) {
    console.error('Failed to set audio output device:', err)
  }
}

async function joinRoom(name, room_id) {
  if (rc && rc.isOpen()) {
    console.log('Already connected to a room')
    return
  }

  const trimmedName = (name || '').trim()
  if (!trimmedName) {
    showNotification('Please enter your name before joining.')
    return
  }

  currentDisplayName = trimmedName
  currentRoomId = room_id

  // Stop lobby preview stream before entering the room UI-wise,
  // but only after validations pass we will proceed to mediasoup join.

  // Pre-join validation with external APIs
  try {
    const { allowed, sessionInfo } = await checkOwnershipAndOngoing(room_id, trimmedName)
    if (!allowed) {
      return
    }

    const sessionId = extractSessionId(sessionInfo)
    currentSessionId = sessionId

    // Track join (non-blocking)
    if (sessionId) {
      trackJoin(sessionId, trimmedName).then((attendanceId) => {
        currentAttendanceId = attendanceId
      })
    }
  } catch (e) {
    console.error('Pre-join validation failed:', e)
    // Do not block join on API failure
  }

  // At this point, join is allowed – proceed with mediasoup client
  // Stop lobby preview stream before entering the room
  if (lobbyPreviewStream && lobbyPreviewStream.getTracks) {
    lobbyPreviewStream.getTracks().forEach((t) => t.stop())
    lobbyPreviewStream = null
  }
  if (typeof lobbyPreview !== 'undefined') {
    lobbyPreview.classList.add('hidden')
  }

  initEnumerateDevices()

  rc = new RoomClient(
    videoGrid,
    videoGrid,
    remoteAudios,
    window.mediasoupClient,
    socket,
    room_id,
    trimmedName,
    roomOpen,
    {
      isTrainer: isTrainerFlag === '1',
      profilePic: currentUserProfile && (currentUserProfile.profile_pic || currentUserProfile.avatar_url || currentUserProfile.avatar)
    }
  )

  addListeners()

  // Initial self-join notification
  showNotification(`You joined room "${room_id}" as "${trimmedName}"`)
}

function roomOpen() {
  // Hide lobby elements
  if (typeof lobbyJoinCard !== 'undefined') {
    hide(lobbyJoinCard)
  }
  if (typeof lobbyPreview !== 'undefined') {
    hide(lobbyPreview)
  }

  // Show room controls
  reveal(startAudioButton)
  hide(stopAudioButton)
  reveal(startVideoButton)
  hide(stopVideoButton)
  reveal(exitButton)
  reveal(participantsButton)
  reveal(control)
  reveal(videoMedia)

  // Show audio and video controls with dropdowns
  if (typeof audioControls !== 'undefined') {
    reveal(audioControls)
  }
  if (typeof videoControls !== 'undefined') {
    reveal(videoControls)
  }

  // Warm up audio once so that producing video first does not hit
  // browser SDP/recv-parameter quirks. We immediately close the
  // temporary audio producer, so from the UI perspective audio
  // is still "off".
  if (!didAudioWarmup && typeof rc !== 'undefined') {
    didAudioWarmup = true
    rc
      .produce(RoomClient.mediaType.audio, typeof audioSelect !== 'undefined' ? audioSelect.value : undefined)
      .then(() => {
        rc.closeProducer(RoomClient.mediaType.audio)
      })
      .catch((err) => {
        console.error('Audio warmup failed:', err)
      })
  }
}

function hide(elem) {
  if (!elem) return
  elem.classList.add('hidden')
}

function reveal(elem) {
  if (!elem) return
  elem.classList.remove('hidden')
}

function addListeners() {
  rc.on(RoomClient.EVENTS.stopAudio, () => {
    hide(stopAudioButton)
    reveal(startAudioButton)
  })
  rc.on(RoomClient.EVENTS.startAudio, () => {
    hide(startAudioButton)
    reveal(stopAudioButton)
  })

  rc.on(RoomClient.EVENTS.startVideo, () => {
    hide(startVideoButton)
    reveal(stopVideoButton)
  })
  rc.on(RoomClient.EVENTS.stopVideo, () => {
    hide(stopVideoButton)
    reveal(startVideoButton)
  })
  rc.on(RoomClient.EVENTS.exitRoom, () => {
    hide(control)
    hide(participantsModal)
    hide(videoMedia)
    if (typeof audioControls !== 'undefined') {
      hide(audioControls)
    }
    if (typeof videoControls !== 'undefined') {
      hide(videoControls)
    }
    // Show lobby elements
    if (typeof lobbyJoinCard !== 'undefined') {
      reveal(lobbyJoinCard)
    }
    if (typeof lobbyPreview !== 'undefined') {
      reveal(lobbyPreview)
    }
  })

  // Handle device selection changes
  if (typeof audioSelect !== 'undefined') {
    audioSelect.addEventListener('change', async (e) => {
      const deviceId = e.target.value
      // If audio is currently active, restart with new device
      if (rc && stopAudioButton && !stopAudioButton.classList.contains('hidden')) {
        await rc.closeProducer(RoomClient.mediaType.audio)
        await rc.produce(RoomClient.mediaType.audio, deviceId)
      }
    })
  }

  if (typeof videoSelect !== 'undefined') {
    videoSelect.addEventListener('change', async (e) => {
      const deviceId = e.target.value
      // If video is currently active, restart with new device
      if (rc && stopVideoButton && !stopVideoButton.classList.contains('hidden')) {
        await rc.closeProducer(RoomClient.mediaType.video)
        await rc.produce(RoomClient.mediaType.video, deviceId)
      }
    })
  }
}

async function leaveAndExit() {
  // Track leave (non-blocking)
  try {
    await trackLeave(currentSessionId, currentDisplayName, currentAttendanceId, false)
  } catch (e) {
    console.error('Leave tracking failed:', e)
  }

  if (rc) {
    rc.exit()
  }
}

// Pinned (spotlight) mode
window.setPinnedCard = function (card) {
  if (!card) return
  const pinnedContainer = pinnedContainerEl()
  const grid = videoGrid
  if (!pinnedContainer || !grid) return

  // Unpin if clicking the currently pinned card
  if (pinnedCard === card) {
    pinnedContainer.classList.add('hidden')
    grid.appendChild(card)
    pinnedCard = null
    // Update layout when unpinning
    setTimeout(() => {
      window.updateGridLayout()
    }, 100)
    return
  }

  // Move previous pinned back to grid
  if (pinnedCard && pinnedCard.parentNode === pinnedContainer) {
    grid.appendChild(pinnedCard)
  }

  pinnedContainer.innerHTML = ''
  pinnedContainer.appendChild(card)
  pinnedContainer.classList.remove('hidden')
  pinnedCard = card

  // Update layout when pinning
  setTimeout(() => {
    window.updateGridLayout()
  }, 100)
}

function pinnedContainerEl() {
  return typeof pinnedContainer !== 'undefined' ? pinnedContainer : document.getElementById('pinnedContainer')
}

let isEnumerateDevices = false

function initEnumerateDevices() {
  // Many browsers, without the consent of getUserMedia, cannot enumerate the devices.
  if (isEnumerateDevices) return

  const constraints = {
    audio: true,
    video: true
  }

  navigator.mediaDevices
    .getUserMedia(constraints)
    .then((stream) => {
      enumerateDevices()
      stream.getTracks().forEach(function (track) {
        track.stop()
      })
    })
    .catch((err) => {
      console.error('Access denied for audio/video: ', err)
    })
}

function enumerateDevices() {
  // Load mediaDevice options
  navigator.mediaDevices.enumerateDevices().then((devices) =>
    devices.forEach((device) => {
      let el = null
      if ('audioinput' === device.kind) {
        el = audioSelect
      } else if ('videoinput' === device.kind) {
        el = videoSelect
      }
      if (!el) return

      let option = document.createElement('option')
      option.value = device.deviceId
      option.innerText = device.label
      el.appendChild(option)
      isEnumerateDevices = true
    })
  )
}

async function openParticipantsModal() {
  if (!rc || typeof rc.roomInfo !== 'function') return

  try {
    const info = await rc.roomInfo()
    const listEl = participantsList
    listEl.innerHTML = ''

    if (info && info.peers) {
      const peersArr = JSON.parse(info.peers)

      if (!Array.isArray(peersArr) || peersArr.length === 0) {
        const empty = document.createElement('div')
        empty.textContent = 'No other participants in the room.'
        listEl.appendChild(empty)
      } else {
        peersArr.forEach(([socketId, peer]) => {
          const name = (peer && peer.name) || 'Participant'
          const hasAudio = !!(peer && peer.hasAudio)
          const hasVideo = !!(peer && peer.hasVideo)
          const isPeerTrainer = !!(peer && peer.isTrainer)

          const item = document.createElement('div')
          item.className = 'flex items-center justify-between gap-2'

          const left = document.createElement('div')
          left.className = 'flex items-center gap-2'

          const icon = document.createElement('i')
          icon.className = 'fas fa-user text-gray-500'
          const label = document.createElement('span')
          label.textContent = name

          left.appendChild(icon)
          left.appendChild(label)

          const status = document.createElement('div')
          status.className = 'flex items-center gap-3 text-xs text-gray-600'

          const audioSpan = document.createElement('span')
          audioSpan.className = 'flex items-center gap-1'
          const audioIcon = document.createElement('i')
          audioIcon.className = hasAudio ? 'fas fa-microphone text-emerald-500' : 'fas fa-microphone-slash text-gray-400'
          const audioLabel = document.createElement('span')
          audioLabel.textContent = hasAudio ? 'Audio on' : 'Audio off'
          audioSpan.appendChild(audioIcon)
          audioSpan.appendChild(audioLabel)

          const videoSpan = document.createElement('span')
          videoSpan.className = 'flex items-center gap-1'
          const videoIcon = document.createElement('i')
          videoIcon.className = hasVideo ? 'fas fa-video text-emerald-500' : 'fas fa-video-slash text-gray-400'
          const videoLabel = document.createElement('span')
          videoLabel.textContent = hasVideo ? 'Video on' : 'Video off'
          videoSpan.appendChild(videoIcon)
          videoSpan.appendChild(videoLabel)

          status.appendChild(audioSpan)
          status.appendChild(videoSpan)

          item.appendChild(left)
          item.appendChild(status)

          // If current user is trainer/owner, allow moderation controls on non-trainers
          if (rc && rc.isTrainer && !isPeerTrainer && socketId) {
            const actions = document.createElement('div')
            actions.className = 'flex items-center gap-2 ml-2'

            const muteButton = document.createElement('button')
            muteButton.type = 'button'
            muteButton.className =
              'px-2 py-1 rounded text-xs bg-emerald-600 text-white hover:bg-emerald-700 transition-colors'

            if (hasAudio) {
              muteButton.textContent = 'Mute'
              muteButton.onclick = () => trainerMuteParticipant(socketId, name)
            } else {
              muteButton.textContent = 'Ask to unmute'
              muteButton.onclick = () => trainerRequestUnmute(socketId, name)
            }

            actions.appendChild(muteButton)
            item.appendChild(actions)
          }

          listEl.appendChild(item)
        })
      }
    } else {
      const empty = document.createElement('div')
      empty.textContent = 'No participants information available.'
      listEl.appendChild(empty)
    }
  } catch (e) {
    console.error('Failed to load participants:', e)
    const listEl = participantsList
    listEl.innerHTML = ''
    const errorEl = document.createElement('div')
    errorEl.textContent = 'Failed to load participants.'
    listEl.appendChild(errorEl)
  }

  reveal(participantsModal)
}

async function trainerMuteParticipant(socketId, name) {
  if (!socketId) return
  try {
    const res = await socket.request('moderateAudio', {
      targetSocketId: socketId,
      action: 'mute'
    })
    if (res && res.error) {
      console.error('Mute failed:', res.error)
      showNotification(`Failed to mute ${name}`)
      return
    }
    showNotification(`Muted ${name}'s microphone`)

    // Refresh participants list so mic state/icons and button label update
    try {
      if (
        typeof openParticipantsModal === 'function' &&
        typeof participantsModal !== 'undefined' &&
        !participantsModal.classList.contains('hidden')
      ) {
        await openParticipantsModal()
      }
    } catch (e) {
      console.warn('Failed to refresh participants after mute:', e)
    }
  } catch (e) {
    console.error('Mute request failed:', e)
    showNotification(`Failed to mute ${name}`)
  }
}

async function trainerRequestUnmute(socketId, name) {
  if (!socketId) return
  try {
    const res = await socket.request('moderateAudio', {
      targetSocketId: socketId,
      action: 'requestUnmute'
    })
    if (res && res.error) {
      console.error('Request unmute failed:', res.error)
      showNotification(`Failed to send unmute request to ${name}`)
      return
    }
    showNotification(`Asked ${name} to unmute`)

    // Refresh participants list so mic state/icons and button label update
    try {
      if (
        typeof openParticipantsModal === 'function' &&
        typeof participantsModal !== 'undefined' &&
        !participantsModal.classList.contains('hidden')
      ) {
        await openParticipantsModal()
      }
    } catch (e) {
      console.warn('Failed to refresh participants after unmute request:', e)
    }
  } catch (e) {
    console.error('Request unmute failed:', e)
    showNotification(`Failed to send unmute request to ${name}`)
  }
}

function closeParticipantsModal() {
  hide(participantsModal)
}

// Simple toast-style notification using Tailwind classes
function showNotification(message, timeout = 3000) {
  const container = document.querySelector('#toastContainer > div')
  if (!container) return

  const toast = document.createElement('div')
  toast.className =
    'pointer-events-auto rounded-lg toast-notification text-white text-sm px-4 py-2 shadow-lg flex items-center gap-2'

  const icon = document.createElement('i')
  icon.className = 'fas fa-info-circle text-blue-400'
  const text = document.createElement('span')
  text.textContent = message

  toast.appendChild(icon)
  toast.appendChild(text)
  container.appendChild(toast)

  setTimeout(() => {
    toast.classList.add('opacity-0', 'transition-opacity', 'duration-300')
    setTimeout(() => {
      toast.remove()
    }, 300)
  }, timeout)
}

// Track leave on browser/tab close with keepalive
window.addEventListener('beforeunload', () => {
  trackLeave(currentSessionId, currentDisplayName, currentAttendanceId, true)
})
