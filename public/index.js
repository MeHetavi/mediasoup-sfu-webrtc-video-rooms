if (location.href.substr(0, 5) !== 'https') location.href = 'https' + location.href.substr(4, location.href.length - 4)

const socket = io()

let producer = null
let lobbyPreviewStream = null
let lobbyAudioDeviceId = null
let lobbyVideoDeviceId = null

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

// Parse URL parameters
const urlParams = new URLSearchParams(window.location.search)
const usernameFromUrl = urlParams.get('username')
const isTrainerFromUrl = urlParams.get('isTrainer')

// API Base URL - can be set via window.API_BASE_URL or config.js
const API_BASE_URL = window.API_BASE_URL || (typeof config !== 'undefined' && config.API_BASE_URL) || 'https://prana.ycp.life/api/v1'
const PROFILE_PIC_BASE_URL = 'https://prana.ycp.life'

let authToken = null
let currentUserProfile = null
let currentRoomId = roomFromUrl
let currentDisplayName = null
// Try to restore attendance ID from sessionStorage if available
let currentAttendanceId = null
try {
  const storedAttendanceId = sessionStorage.getItem('attendanceId')
  const storedRoomId = sessionStorage.getItem('attendanceRoomId')
  // Only restore if it's for the same room
  if (storedAttendanceId && storedRoomId === roomFromUrl) {
    currentAttendanceId = storedAttendanceId
    console.log('Restored attendance ID from sessionStorage:', currentAttendanceId)
  }
} catch (e) {
  console.warn('Failed to restore attendance ID from sessionStorage:', e)
}
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
  video.muted = true // Ensure muted to prevent audio issues
  video.controls = false
  video.disablePictureInPicture = true
  video.setAttribute('playsinline', 'true')
  video.setAttribute('webkit-playsinline', 'true')
  video.className = 'vid hidden'

  // Prevent video from opening browser's video player
  // CSS pointer-events: none will make clicks pass through to card
  // But add additional prevention just in case
  video.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    return false
  })

  // Prevent context menu and double-click on video
  video.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    e.stopPropagation()
    return false
  })

  video.addEventListener('dblclick', (e) => {
    e.preventDefault()
    e.stopPropagation()
    return false
  })

  card.appendChild(video)

  grid.appendChild(card)

  // Make card interactive for pinning
  card.style.cursor = 'pointer'

  // Add pin icon button
  addPinButtonToCard(card)

  // Allow pinning by clicking the card
  card.addEventListener('click', (e) => {
    // Don't pin if clicking the pin button itself (it has its own handler)
    if (e.target.closest('.pin-button')) return
    if (window.setPinnedCard) {
      window.setPinnedCard(card)
    }
  })

  window.updateGridLayout()
}

// Add pin button to a video card
function addPinButtonToCard(card) {
  // Check if pin button already exists
  if (card.querySelector('.pin-button')) return

  const pinButton = document.createElement('button')
  pinButton.className = 'pin-button'
  pinButton.type = 'button'
  pinButton.title = 'Pin video'
  pinButton.innerHTML = '<i class="fas fa-thumbtack"></i>'

  pinButton.addEventListener('click', (e) => {
    e.stopPropagation()
    if (window.setPinnedCard) {
      window.setPinnedCard(card)
    }
  })

  card.appendChild(pinButton)
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
    'layout-pinned', 'layout-pinned-mobile', 'layout-mobile-5-6'
  )

  // Handle pinned video layouts - show pinned video large with scrollable list of others
  // Calculate effective count (excluding pinned card) for layout
  const effectiveCount = hasPinned ? Math.max(0, n - 1) : n

  if (hasPinned) {
    // Keep all other cards visible in list (they'll be shown beside/below pinned video)
    cards.forEach(card => {
      if (card !== pinnedCard) {
        card.style.display = ''
        card.style.visibility = 'visible'
        card.style.opacity = '1'
      }
    })

    // Show both pinned container and grid wrapper
    const gridWrapper = document.getElementById('videoGridWrapper')
    if (gridWrapper) {
      gridWrapper.style.display = 'flex'
    }

    // Add list class for pinned mode
    grid.classList.add('pinned-list')

    // Hide pagination buttons in pinned mode (scroll handles overflow)
    hidePaginationButtons()

    // Layout handled by CSS for pinned mode; skip grid layout logic
    return
  } else {
    // Show grid wrapper when not pinned
    const gridWrapper = document.getElementById('videoGridWrapper')
    if (gridWrapper) {
      gridWrapper.style.display = 'flex'
    }
    grid.classList.remove('pinned-list')
  }

  // Auto-pin on mobile disabled - will be implemented later
  // if (screenSize === 'mobile' && n > 4) {
  //   const firstCard = cards[0]
  //   if (firstCard && window.setPinnedCard) {
  //     window.setPinnedCard(firstCard)
  //     return
  //   }
  // }

  // Apply layout based on screen size and participant count
  // Use effectiveCount (excludes pinned card when pinned)
  const countForLayout = effectiveCount
  if (screenSize === 'mobile') {
    // Mobile layouts
    if (countForLayout === 0) {
      // Only pinned video, no others
      hidePaginationButtons()
    } else if (countForLayout === 1 || countForLayout === 2) {
      grid.classList.add(countForLayout === 1 ? 'layout-1' : 'layout-2')
      hidePaginationButtons()
    } else if (countForLayout === 3 || countForLayout === 4) {
      grid.classList.add('layout-4')
      hidePaginationButtons()
    } else if (countForLayout === 5 || countForLayout === 6) {
      // 5-6 cameras: 3 rows, 2 cameras per row
      grid.classList.add('layout-mobile-5-6')
      hidePaginationButtons()
    } else {
      // More than 6 cameras: enable pagination (6 per page for mobile)
      grid.classList.add('layout-mobile-5-6') // Use same layout, but paginated
      setupMobilePagination(cards.filter(c => c !== pinnedCard), countForLayout)
    }
  } else if (screenSize === 'tablet') {
    // Tablet layouts
    if (countForLayout === 0) {
      // Only pinned video
    } else if (countForLayout === 1) {
      grid.classList.add('layout-1')
    } else if (countForLayout === 2) {
      grid.classList.add('layout-2')
    } else if (countForLayout === 3 || countForLayout === 4) {
      grid.classList.add('layout-4')
    } else {
      grid.classList.add('layout-5plus')
    }
  } else if (screenSize === 'small-desktop') {
    // Small desktop layouts
    if (countForLayout === 0) {
      // Only pinned video
    } else if (countForLayout === 1) {
      grid.classList.add('layout-1')
    } else if (countForLayout === 2) {
      grid.classList.add('layout-2')
    } else if (countForLayout === 3) {
      grid.classList.add('layout-3')
    } else if (countForLayout === 4) {
      grid.classList.add('layout-4')
    } else {
      grid.classList.add('layout-5plus')
    }
  } else {
    // Large desktop layouts - with pagination for > 12 videos
    if (countForLayout === 0) {
      // Only pinned video
      hidePaginationButtons()
    } else if (countForLayout === 1) {
      grid.classList.add('layout-1')
      hidePaginationButtons()
    } else if (countForLayout === 2) {
      grid.classList.add('layout-2')
      hidePaginationButtons()
    } else if (countForLayout === 3) {
      grid.classList.add('layout-3')
      hidePaginationButtons()
    } else if (countForLayout === 4) {
      grid.classList.add('layout-4')
      hidePaginationButtons()
    } else if (countForLayout === 5 || countForLayout === 6) {
      grid.classList.add(countForLayout === 5 ? 'layout-5' : 'layout-6')
      hidePaginationButtons()
    } else if (countForLayout === 7 || countForLayout === 8) {
      grid.classList.add(countForLayout === 7 ? 'layout-7' : 'layout-8')
      hidePaginationButtons()
    } else if (countForLayout === 9) {
      grid.classList.add('layout-9')
      hidePaginationButtons()
    } else if (countForLayout >= 10 && countForLayout <= 12) {
      grid.classList.add(`layout-${countForLayout}`)
      hidePaginationButtons()
    } else {
      // More than 12 videos - enable pagination
      grid.classList.add('layout-12') // Always show 12 per page
      setupPagination(cards.filter(c => c !== pinnedCard), countForLayout)
    }
  }
}

// Pagination functions
function setupPagination(cards, totalCount) {
  const totalPages = Math.ceil(totalCount / VIDEOS_PER_PAGE)

  // Reset to last valid page if current page is out of bounds
  if (currentGridPage >= totalPages && totalPages > 0) {
    currentGridPage = Math.max(0, totalPages - 1)
  }

  // If no cards, reset to page 0
  if (totalCount === 0) {
    currentGridPage = 0
  }

  // Show/hide cards based on current page
  cards.forEach((card, index) => {
    const startIndex = currentGridPage * VIDEOS_PER_PAGE
    const endIndex = startIndex + VIDEOS_PER_PAGE

    if (index >= startIndex && index < endIndex) {
      card.style.display = ''
      card.style.visibility = 'visible'
      card.style.opacity = '1'
    } else {
      card.style.display = 'none'
      card.style.visibility = 'hidden'
      card.style.opacity = '0'
    }
  })

  // Show/hide navigation buttons
  const prevBtn = document.getElementById('gridPagePrev')
  const nextBtn = document.getElementById('gridPageNext')

  if (totalPages > 1) {
    if (prevBtn) {
      prevBtn.classList.remove('hidden')
      prevBtn.disabled = currentGridPage === 0
      if (currentGridPage === 0) {
        prevBtn.style.opacity = '0.5'
        prevBtn.style.cursor = 'not-allowed'
      } else {
        prevBtn.style.opacity = '1'
        prevBtn.style.cursor = 'pointer'
      }
    }

    if (nextBtn) {
      nextBtn.classList.remove('hidden')
      nextBtn.disabled = currentGridPage >= totalPages - 1
      if (currentGridPage >= totalPages - 1) {
        nextBtn.style.opacity = '0.5'
        nextBtn.style.cursor = 'not-allowed'
      } else {
        nextBtn.style.opacity = '1'
        nextBtn.style.cursor = 'pointer'
      }
    }
  } else {
    hidePaginationButtons()
  }
}

function hidePaginationButtons() {
  const prevBtn = document.getElementById('gridPagePrev')
  const nextBtn = document.getElementById('gridPageNext')

  if (prevBtn) prevBtn.classList.add('hidden')
  if (nextBtn) nextBtn.classList.add('hidden')

  // Make sure all cards are visible when pagination is disabled
  const grid = getGridContainer()
  if (grid) {
    const cards = Array.from(grid.querySelectorAll('.video-card'))
    cards.forEach(card => {
      card.style.display = ''
      card.style.visibility = 'visible'
      card.style.opacity = '1'
    })
  }
}


function goToNextPage() {
  const grid = getGridContainer()
  if (!grid) return

  const cards = Array.from(grid.querySelectorAll('.video-card'))
  const totalCount = cards.length
  const screenSize = getScreenSize()
  const videosPerPage = screenSize === 'mobile' ? VIDEOS_PER_PAGE_MOBILE : VIDEOS_PER_PAGE
  const totalPages = Math.ceil(totalCount / videosPerPage)

  if (currentGridPage < totalPages - 1) {
    currentGridPage++
    if (screenSize === 'mobile') {
      setupMobilePagination(cards, totalCount)
    } else {
      setupPagination(cards, totalCount)
    }
  }
}

function goToPreviousPage() {
  const grid = getGridContainer()
  if (!grid) return

  const cards = Array.from(grid.querySelectorAll('.video-card'))
  const totalCount = cards.length
  const screenSize = getScreenSize()

  if (screenSize === 'mobile') {
    if (currentGridPage > 0) {
      currentGridPage--
      setupMobilePagination(cards, totalCount)
    }
  } else {
    if (currentGridPage > 0) {
      currentGridPage--
      setupPagination(cards, totalCount)
    }
  }
}

// Mobile pagination setup (6 videos per page)
function setupMobilePagination(cards, totalCount) {
  const totalPages = Math.ceil(totalCount / VIDEOS_PER_PAGE_MOBILE)

  // Reset to last valid page if current page is out of bounds
  if (currentGridPage >= totalPages && totalPages > 0) {
    currentGridPage = Math.max(0, totalPages - 1)
  }

  // If no cards, reset to page 0
  if (totalCount === 0) {
    currentGridPage = 0
  }

  // Show/hide cards based on current page
  cards.forEach((card, index) => {
    const startIndex = currentGridPage * VIDEOS_PER_PAGE_MOBILE
    const endIndex = startIndex + VIDEOS_PER_PAGE_MOBILE

    if (index >= startIndex && index < endIndex) {
      card.style.display = ''
      card.style.visibility = 'visible'
      card.style.opacity = '1'
    } else {
      card.style.display = 'none'
      card.style.visibility = 'hidden'
      card.style.opacity = '0'
    }
  })

  // Show/hide navigation buttons
  const prevBtn = document.getElementById('gridPagePrev')
  const nextBtn = document.getElementById('gridPageNext')

  if (totalPages > 1) {
    if (prevBtn) {
      prevBtn.classList.remove('hidden')
      prevBtn.disabled = currentGridPage === 0
      if (currentGridPage === 0) {
        prevBtn.style.opacity = '0.5'
        prevBtn.style.cursor = 'not-allowed'
      } else {
        prevBtn.style.opacity = '1'
        prevBtn.style.cursor = 'pointer'
      }
    }

    if (nextBtn) {
      nextBtn.classList.remove('hidden')
      nextBtn.disabled = currentGridPage >= totalPages - 1
      if (currentGridPage >= totalPages - 1) {
        nextBtn.style.opacity = '0.5'
        nextBtn.style.cursor = 'not-allowed'
      } else {
        nextBtn.style.opacity = '1'
        nextBtn.style.cursor = 'pointer'
      }
    }
  } else {
    hidePaginationButtons()
  }
}

// Reflow on resize with debounce
let resizeTimeout
window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout)
  resizeTimeout = setTimeout(() => {
    currentGridPage = 0 // Reset to first page on resize
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
    localStorage.setItem('access_token', fromUrl) // Also store as access_token
    authToken = fromUrl
    return authToken
  }
  // Check both localStorage keys
  const stored = localStorage.getItem('authToken') || localStorage.getItem('access_token')
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
    // Store in window.userProfile for external access
    window.userProfile = profile
  }
  return currentUserProfile
}

// Helper function to construct profile picture URL
function getProfilePicUrl(profilePic) {
  if (!profilePic) return null
  // If it starts with http, use as-is
  if (profilePic.startsWith('http://') || profilePic.startsWith('https://')) {
    return profilePic
  }
  // Otherwise construct from base URL
  return `${PROFILE_PIC_BASE_URL}/${profilePic.replace(/^\//, '')}`
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

    // Use username from URL if available, otherwise use profile name
    const displayName = usernameFromUrl || name
    if (displayName && typeof nameInput !== 'undefined') {
      nameInput.value = displayName
    }

    if (typeof lobbyUserName !== 'undefined') {
      // Update the display name (username format)
      const username = name ? `@${name.toLowerCase().replace(/\s+/g, '')}` : '@user'
      lobbyUserName.textContent = username
    }

    const avatarEl = typeof lobbyUserAvatar !== 'undefined' ? lobbyUserAvatar : null
    if (avatarEl) {
      if (avatarUrl) {
        // Use helper function to construct proper URL
        const profilePicUrl = getProfilePicUrl(avatarUrl)
        avatarEl.style.backgroundImage = `url('${profilePicUrl}')`
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



async function checkOwnershipAndOngoing(roomId, displayName) {
  const token = getAuthToken()
  isTrainerFlag = '0'

  // Step 1: Check ownership (for trainers/owners)
  let isOwner = false
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
          isOwner = true
          // Owners/trainers can always join, even if occurrence is not ongoing
          return { allowed: true }
        }
      }
    }
  }

  // Step 2: Check session status (for non-owners)
  // This allows unauthenticated check (no token required)
  const ongoingUrl = buildApiUrl(`/session-occurrences/session/${encodeURIComponent(roomId)}/ongoing`)
  const ongoing = await safeJsonFetch(ongoingUrl, {
    method: 'GET',
    headers: authHeaders(true) // Token optional for this endpoint
  })

  if (!ongoing) {
    console.warn('Ongoing check failed; blocking join for safety.')
    return { allowed: false, message: 'Waiting for Yogacharya to start the session.' }
  }
  console.log('Ongoing check successful:', ongoing)
  const isOngoing = ongoing.ongoing === true || ongoing.is_ongoing === true
  console.log('Is ongoing:', isOngoing)
  const ongoingOccurrence = ongoing.data?.ongoing_occurrence || ongoing.ongoing_occurrence

  // If not ongoing and user is not owner, block join
  if (!isOngoing && !ongoingOccurrence) {
    return { allowed: false, message: 'Waiting for Yogacharya to start the session.' }
  }

  // If ongoing, allow join
  return { allowed: true }
}

// Track attendance join
async function trackAttendanceJoin(sessionId, displayName) {
  if (!sessionId) {
    console.warn('Cannot track join: sessionId is missing')
    return null
  }

  // Ensure name is always sent, even without token
  const name = displayName || (typeof nameInput !== 'undefined' ? nameInput.value : '') || ''

  const url = buildApiUrl(`/attendances/session/${encodeURIComponent(sessionId)}/join`)
  const form = new FormData()
  form.append('name', name)

  console.log('Calling join API', { sessionId, name })

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(false), // Don't include Content-Type, let browser set it for FormData
      body: form
    })
    if (!res.ok) {
      console.error('Join attendance tracking failed:', res.status, res.statusText)
      return null
    }
    const data = await res.json().catch(() => null)
    // Extract attendance_id from the nested response structure
    // Response format: {success: true, data: {attendance: {attendance_id: 15, ...}, ...}, ...}
    const attendanceId = data && (
      data.data?.attendance?.attendance_id ||  // Primary: nested in data.attendance.attendance_id
      data.data?.attendance_id ||              // Fallback: data.attendance_id
      data.attendance?.attendance_id ||        // Fallback: attendance.attendance_id
      data.attendance_id ||                    // Fallback: direct attendance_id
      data.data?.id ||                         // Fallback: data.id
      data.id ||                               // Fallback: direct id
      data.attendanceId ||                     // Fallback: camelCase
      data.data?.attendanceId                   // Fallback: data.attendanceId
    )
    console.log('Join API response data:', { data, attendanceId, extractedFrom: data?.data?.attendance?.attendance_id ? 'data.attendance.attendance_id' : 'other' })

    // Store immediately if available
    if (attendanceId) {
      currentAttendanceId = attendanceId
      try {
        sessionStorage.setItem('attendanceId', String(attendanceId))
        console.log('Attendance ID stored from API response:', attendanceId)
      } catch (e) {
        console.warn('Failed to store attendance ID in sessionStorage:', e)
      }
    } else {
      console.warn('Could not extract attendance_id from response:', data)
    }

    return attendanceId
  } catch (e) {
    console.error('Join attendance tracking request failed:', e)
    return null
  }
}

// Track attendance leave
async function trackAttendanceLeave(sessionId, displayName, attendanceId, useKeepalive = false) {
  if (!sessionId) {
    console.warn('Cannot track leave: sessionId is missing', { sessionId, attendanceId })
    return
  }

  // Ensure name is always sent, even without token
  const name = displayName || currentDisplayName || (typeof nameInput !== 'undefined' ? nameInput.value : '') || ''

  // Use attendanceId parameter, or fallback to currentAttendanceId global variable
  const finalAttendanceId = attendanceId || currentAttendanceId

  const url = buildApiUrl(`/attendances/session/${encodeURIComponent(sessionId)}/leave`)
  const form = new FormData()
  form.append('name', name)

  // Always include attendance_id if available
  if (finalAttendanceId) {
    form.append('attendance_id', finalAttendanceId)
    console.log('Calling leave API with attendance_id', { sessionId, name, attendanceId: finalAttendanceId, useKeepalive })
  } else {
    console.warn('Calling leave API without attendance_id', { sessionId, name, useKeepalive })
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(false), // Don't include Content-Type, let browser set it for FormData
      body: form,
      keepalive: useKeepalive
    })
    if (!res.ok) {
      console.error('Leave attendance tracking failed:', res.status, res.statusText)
    } else {
      console.log('Leave attendance tracking successful')
    }
  } catch (e) {
    console.error('Leave attendance tracking request failed:', e)
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

    // Set initial icon states based on track status
    const audioTracks = stream.getAudioTracks()
    const hasAudio = audioTracks.length > 0 && audioTracks[0].enabled
    if (typeof lobbyToggleAudio !== 'undefined') {
      const audioIcon = lobbyToggleAudio.querySelector('img') || document.getElementById('lobbyMicIcon')
      if (audioIcon) {
        audioIcon.src = hasAudio ? '/mic_on.svg' : '/mic_off.svg'
      }
    }

    const hasVideo = videoTracks.length > 0 && videoTracks[0].enabled
    if (typeof lobbyToggleVideo !== 'undefined') {
      const videoIcon = lobbyToggleVideo.querySelector('img') || document.getElementById('lobbyCameraIcon')
      if (videoIcon) {
        videoIcon.src = hasVideo ? '/camera_on.svg' : '/camera_off.svg'
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
    const icon = lobbyToggleAudio.querySelector('img') || document.getElementById('lobbyMicIcon')
    if (icon) {
      if (!enabled) {
        icon.src = '/mic_off.svg'
      } else {
        icon.src = '/mic_on.svg'
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
    const icon = lobbyToggleVideo.querySelector('img') || document.getElementById('lobbyCameraIcon')
    if (icon) {
      if (!enabled) {
        icon.src = '/camera_off.svg'
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
        icon.src = '/camera_on.svg'
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

    // Update icon states after stream refresh
    const audioTracks = stream.getAudioTracks()
    const hasAudio = audioTracks.length > 0 && audioTracks[0].enabled
    if (typeof lobbyToggleAudio !== 'undefined') {
      const audioIcon = lobbyToggleAudio.querySelector('img') || document.getElementById('lobbyMicIcon')
      if (audioIcon) {
        audioIcon.src = hasAudio ? '/mic_on.svg' : '/mic_off.svg'
      }
    }

    const videoTracks = stream.getVideoTracks()
    const hasVideo = videoTracks.length > 0 && videoTracks[0].enabled
    if (typeof lobbyToggleVideo !== 'undefined') {
      const videoIcon = lobbyToggleVideo.querySelector('img') || document.getElementById('lobbyCameraIcon')
      if (videoIcon) {
        videoIcon.src = hasVideo ? '/camera_on.svg' : '/camera_off.svg'
      }
    }

    // Update video preview visibility
    if (hasVideo && videoTracks[0].readyState === 'live') {
      if (typeof lobbyVideoPreview !== 'undefined') {
        lobbyVideoPreview.classList.remove('hidden')
      }
      if (typeof lobbyVideoPlaceholder !== 'undefined') {
        lobbyVideoPlaceholder.classList.add('hidden')
      }
    } else {
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
    const { allowed, message } = await checkOwnershipAndOngoing(room_id, trimmedName)
    if (!allowed) {
      // Show the message if provided (e.g., "Waiting for Yogacharya to start")
      if (message) {
        showNotification(message)
      }
      return
    }
  } catch (e) {
    console.error('Pre-join validation failed:', e)
    // On API failure, block join for safety
    showNotification('Unable to verify session status. Please try again.')
    return
  }

  // Track attendance join (non-blocking)
  // Session ID is the room ID
  trackAttendanceJoin(room_id, trimmedName).then((attendanceId) => {
    console.log('Join API response:', { attendanceId, room_id, name: trimmedName })

    // Store attendance ID in global variable
    if (attendanceId) {
      currentAttendanceId = attendanceId

      // Also store in sessionStorage for persistence across page reloads
      try {
        sessionStorage.setItem('attendanceId', String(attendanceId))
        sessionStorage.setItem('attendanceRoomId', room_id)
        console.log('Attendance ID stored:', attendanceId)
      } catch (e) {
        console.warn('Failed to store attendance ID in sessionStorage:', e)
      }
    } else {
      console.warn('Join API did not return attendanceId')
    }
  }).catch((e) => {
    console.error('Attendance join tracking failed:', e)
  })

  // At this point, join is allowed – proceed with mediasoup client
  // Stop lobby preview stream before entering the room
  if (lobbyPreviewStream && lobbyPreviewStream.getTracks) {
    lobbyPreviewStream.getTracks().forEach((t) => t.stop())
    lobbyPreviewStream = null
  }
  if (typeof lobbyPreview !== 'undefined') {
    lobbyPreview.classList.add('hidden')
  }

  // Clean up any leftover participant cards from previous sessions
  if (videoGrid) {
    const existingCards = videoGrid.querySelectorAll('.video-card')
    existingCards.forEach((card) => {
      const video = card.querySelector('video')
      if (video && video.srcObject) {
        video.srcObject.getTracks().forEach((track) => track.stop())
        video.srcObject = null
      }
      if (card.parentNode) {
        card.parentNode.removeChild(card)
      }
    })
  }

  initEnumerateDevices()

  // Get profile picture URL (handle relative URLs)
  let profilePicUrl = null
  if (currentUserProfile) {
    const profilePic = currentUserProfile.profile_pic || currentUserProfile.avatar_url || currentUserProfile.avatar
    if (profilePic) {
      profilePicUrl = getProfilePicUrl(profilePic)
    }
  }

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
      isTrainer: isTrainerFlag === '1' || isTrainerFromUrl === '1' || isTrainerFromUrl === 'true',
      profilePic: profilePicUrl
    }
  )

  addListeners()

  // Initial self-join notification
  showNotification(`You joined room "${room_id}" as "${trimmedName}"`)
}

function roomOpen() {
  // Dispatch browser CustomEvent for join
  const joinEvent = new CustomEvent('roomJoin', {
    detail: {
      roomId: currentRoomId,
      sessionId: currentRoomId, // session id is the room id
      name: currentDisplayName
    }
  })
  window.dispatchEvent(joinEvent)
  console.log('Join event dispatched', joinEvent.detail)

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
  hide(lobbyContainer)
  reveal(participantsButton)
  reveal(control)
  reveal(mainVideoAreaContainer)
  reveal(videoMedia)

  // Show fullscreen button
  const fullscreenButton = document.getElementById('fullscreenButton')
  if (fullscreenButton) {
    fullscreenButton.classList.remove('hidden')
  }

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
    // Track attendance leave (non-blocking)
    // Session ID is the room ID
    // Call even if attendanceId is missing (API will handle it)
    if (currentRoomId) {
      console.log('exitRoom event triggered, calling leave API', { currentRoomId, currentAttendanceId, currentDisplayName })
      trackAttendanceLeave(currentRoomId, currentDisplayName, currentAttendanceId, false).catch((e) => {
        console.error('Leave attendance tracking failed:', e)
      })
    } else {
      console.warn('Cannot call leave API: currentRoomId is missing')
    }

    // Dispatch browser CustomEvent for leave
    const leaveEvent = new CustomEvent('roomLeave', {
      detail: {
        roomId: currentRoomId,
        sessionId: currentRoomId, // session id is the room id
        name: currentDisplayName
      }
    })
    window.dispatchEvent(leaveEvent)
    console.log('Leave event dispatched', leaveEvent.detail)

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

  // Listen for fullscreen changes to update icon
  document.addEventListener('fullscreenchange', updateFullscreenIcon)
  document.addEventListener('webkitfullscreenchange', updateFullscreenIcon)
  document.addEventListener('mozfullscreenchange', updateFullscreenIcon)
  document.addEventListener('MSFullscreenChange', updateFullscreenIcon)

  // Add mobile-friendly touch handler for fullscreen button
  const fullscreenButton = document.getElementById('fullscreenButton')
  if (fullscreenButton) {
    // Remove onclick and add proper event listeners for better mobile support
    fullscreenButton.onclick = null
    fullscreenButton.addEventListener('click', toggleFullscreen)
    fullscreenButton.addEventListener('touchend', (e) => {
      e.preventDefault()
      e.stopPropagation()
      toggleFullscreen()
    })
  }
}

// Fullscreen toggle function
function toggleFullscreen() {
  const container = document.getElementById('mainVideoAreaContainer')
  const fullscreenIcon = document.getElementById('fullscreenIcon')

  // Detect iOS
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

  // Check if already in fullscreen
  const isFullscreen = !!(document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.mozFullScreenElement ||
    document.msFullscreenElement)

  if (!isFullscreen) {
    // Enter fullscreen
    try {
      if (isIOS) {
        // iOS Safari doesn't support container fullscreen, use viewport workaround
        // Make container take full viewport
        if (container) {
          container.classList.add('ios-fullscreen')
          document.body.style.overflow = 'hidden'

          // Try to make the first visible video fullscreen if available
          const firstVideo = container.querySelector('video:not(.hidden)')
          if (firstVideo && firstVideo.webkitEnterFullscreen) {
            firstVideo.webkitEnterFullscreen()
          }
        }
      } else if (container.requestFullscreen) {
        container.requestFullscreen()
      } else if (container.webkitRequestFullscreen) {
        container.webkitRequestFullscreen(Element.ALLOW_KEYBOARD_INPUT)
      } else if (container.mozRequestFullScreen) {
        container.mozRequestFullScreen()
      } else if (container.msRequestFullscreen) {
        container.msRequestFullscreen()
      }
    } catch (error) {
      console.error('Error entering fullscreen:', error)
      // Fallback for iOS: use viewport approach
      if (isIOS && container) {
        container.classList.add('ios-fullscreen')
        document.body.style.overflow = 'hidden'
      }
    }

    if (fullscreenIcon) {
      fullscreenIcon.className = 'fas fa-compress'
    }
  } else {
    // Exit fullscreen
    try {
      if (isIOS) {
        // Exit iOS fullscreen
        if (container) {
          container.classList.remove('ios-fullscreen')
          document.body.style.overflow = ''
        }
        // Try to exit video fullscreen if active
        if (document.webkitCancelFullScreen) {
          document.webkitCancelFullScreen()
        }
      } else if (document.exitFullscreen) {
        document.exitFullscreen()
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen()
      } else if (document.mozCancelFullScreen) {
        document.mozCancelFullScreen()
      } else if (document.msExitFullscreen) {
        document.msExitFullscreen()
      }
    } catch (error) {
      console.error('Error exiting fullscreen:', error)
      // Fallback for iOS
      if (isIOS && container) {
        container.classList.remove('ios-fullscreen')
        document.body.style.overflow = ''
      }
    }

    if (fullscreenIcon) {
      fullscreenIcon.className = 'fas fa-expand'
    }
  }
}

function updateFullscreenIcon() {
  const fullscreenIcon = document.getElementById('fullscreenIcon')
  const container = document.getElementById('mainVideoAreaContainer')
  const isFullscreen = !!(document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.mozFullScreenElement ||
    document.msFullscreenElement ||
    (container && container.classList.contains('ios-fullscreen')))

  if (fullscreenIcon) {
    fullscreenIcon.className = isFullscreen ? 'fas fa-compress' : 'fas fa-expand'
  }
}

async function leaveAndExit() {
  // Exit fullscreen if active
  const container = document.getElementById('mainVideoAreaContainer')
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

  if (isIOS && container && container.classList.contains('ios-fullscreen')) {
    container.classList.remove('ios-fullscreen')
    document.body.style.overflow = ''
  } else if (document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement) {
    if (document.exitFullscreen) {
      document.exitFullscreen()
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen()
    } else if (document.mozCancelFullScreen) {
      document.mozCancelFullScreen()
    } else if (document.msExitFullscreen) {
      document.msExitFullscreen()
    }
  }

  // Hide fullscreen button
  const fullscreenButton = document.getElementById('fullscreenButton')
  if (fullscreenButton) {
    fullscreenButton.classList.add('hidden')
  }

  hide(mainVideoAreaContainer)
  reveal(lobbyContainer)

  // Track attendance leave (non-blocking)
  // Session ID is the room ID
  // Call even if attendanceId is missing (API will handle it)
  if (currentRoomId) {
    console.log('leaveAndExit called, calling leave API', { currentRoomId, currentAttendanceId, currentDisplayName })
    trackAttendanceLeave(currentRoomId, currentDisplayName, currentAttendanceId, false).catch((e) => {
      console.error('Leave attendance tracking failed:', e)
    })
  } else {
    console.warn('Cannot call leave API: currentRoomId is missing')
  }

  if (rc) {
    rc.exit()
  }
}

// Pinned (spotlight) mode
window.setPinnedCard = function (card) {
  if (!card) return
  const pinnedContainer = pinnedContainerEl()
  const grid = getGridContainer()
  const gridWrapper = document.getElementById('videoGridWrapper')
  if (!pinnedContainer || !grid) return

  // Unpin if clicking the currently pinned card
  if (pinnedCard === card) {
    // Unpin: restore grid layout
    pinnedContainer.classList.add('hidden')

    // Move card back to grid
    if (card.parentNode === pinnedContainer) {
      grid.appendChild(card)
    }

    // Show grid wrapper
    if (gridWrapper) {
      gridWrapper.style.display = 'flex'
    }

    // Show all cards in grid (they were hidden when pinned)
    const allCards = Array.from(grid.querySelectorAll('.video-card'))
    allCards.forEach(c => {
      if (c !== card) {
        c.style.display = ''
        c.style.visibility = 'visible'
        c.style.opacity = '1'
      }
    })

    pinnedCard = null
    card.classList.remove('pinned')

    // Remove pinned list class/state
    grid.classList.remove('pinned-list')

    // Remove pinned state class from videoMedia
    const videoMedia = document.getElementById('videoMedia')
    if (videoMedia) {
      videoMedia.classList.remove('has-pinned')
    }

    // Reset pagination to first page
    currentGridPage = 0

    // Update layout when unpinning
    setTimeout(() => {
      window.updateGridLayout()
    }, 100)
    return
  }

  // Pin: show this card large at top, keep others visible in grid below
  // Move previous pinned back to grid if exists
  if (pinnedCard && pinnedCard.parentNode === pinnedContainer) {
    grid.appendChild(pinnedCard)
    pinnedCard.classList.remove('pinned')
  }

  // Show grid wrapper so other videos remain visible
  if (gridWrapper) {
    gridWrapper.style.display = 'flex'
  }

  // Keep all other cards visible in the grid (don't hide them)
  const allCards = Array.from(grid.querySelectorAll('.video-card'))
  allCards.forEach(c => {
    if (c !== card) {
      c.style.display = ''
      c.style.visibility = 'visible'
      c.style.opacity = '1'
    }
  })

  // Move card to pinned container
  if (card.parentNode) {
    card.parentNode.removeChild(card)
  }

  pinnedContainer.innerHTML = ''
  pinnedContainer.appendChild(card)
  pinnedContainer.classList.remove('hidden')
  pinnedCard = card
  card.classList.add('pinned')
  grid.classList.add('pinned-list')

  // Add class to videoMedia to indicate pinned state for CSS
  const videoMedia = document.getElementById('videoMedia')
  if (videoMedia) {
    videoMedia.classList.add('has-pinned')
  }

  // Keep pagination buttons visible for other videos
  // Don't hide them - we want to paginate through other videos

  // Update layout when pinning - this will handle pinned + grid layout
  setTimeout(() => {
    window.updateGridLayout()
  }, 100)
}

function pinnedContainerEl() {
  return typeof pinnedContainer !== 'undefined' ? pinnedContainer : document.getElementById('pinnedContainer')
}

let isEnumerateDevices = false

// Pagination state for video grid
let currentGridPage = 0
const VIDEOS_PER_PAGE = 12
const VIDEOS_PER_PAGE_MOBILE = 6

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

// Track leave on browser/tab close with keepalive
window.addEventListener('beforeunload', () => {
  if (currentRoomId) {
    console.log('beforeunload event, calling leave API', { currentRoomId, currentAttendanceId, currentDisplayName })
    trackAttendanceLeave(currentRoomId, currentDisplayName, currentAttendanceId, true)
  }
})

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

