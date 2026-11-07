import { useState, useEffect, useRef, useCallback } from 'react'
import './PreviewPane.css'

/**
 * PreviewPane — 60fps GPU-backed live screen capture with monitor selector.
 *
 * Props:
 *   screens        [{id, name, thumbnail}]  - available monitors
 *   currentScreen  {id, name} | null        - active monitor
 *   frameStream    MediaStream | null        - optional external stream override
 *   onScreenChange (screen) => void         - called when the user picks a monitor
 *
 * When `frameStream` is provided it is attached directly (useful for a future
 * Rust-side GPU capture path).  When absent the component opens its own
 * MediaStream via navigator.mediaDevices.getUserMedia using the Electron
 * desktopCapturer source ID supplied in `currentScreen.id`.
 */
export default function PreviewPane({ screens, currentScreen, frameStream, isAppVisible = true, onScreenChange }) {
  const videoRef = useRef(null)
  const internalStreamRef = useRef(null)
  const captureRequestRef = useRef(0)
  const containerRef = useRef(null)
  const [userPaused, setUserPaused] = useState(false)
  const paused = userPaused || !isAppVisible

  // Attach a MediaStream (or null) to the <video> element
  const attachStream = useCallback((stream) => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream ?? null
    }
  }, [])

  const stopCapture = useCallback(() => {
    captureRequestRef.current += 1
    if (internalStreamRef.current) {
      internalStreamRef.current.getTracks().forEach((track) => track.stop())
      internalStreamRef.current = null
    }
  }, [])

  // Open a desktop-capture stream for the given desktopCapturer source ID.
  // The request token prevents a late getUserMedia result from reviving a
  // stream after the app has gone to the tray or the monitor has changed.
  const startCapture = useCallback(
    async (sourceId) => {
      stopCapture()
      const requestId = captureRequestRef.current

      if (!sourceId) {
        attachStream(null)
        return
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: sourceId,
              maxWidth: 1920,
              maxHeight: 1080,
              maxFrameRate: 30,
            },
          },
        })
        if (requestId !== captureRequestRef.current) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        internalStreamRef.current = stream
        attachStream(stream)
        videoRef.current?.play().catch(() => {})
      } catch (err) {
        if (requestId !== captureRequestRef.current) return
        console.warn('PreviewPane: capture unavailable —', err.message)
        attachStream(null)
      }
    },
    [attachStream, stopCapture],
  )

  const togglePlayPause = useCallback(() => {
    setUserPaused((value) => !value)
  }, [])

  // When an external frameStream is supplied it takes precedence over
  // the internal getUserMedia approach (reserved for Rust backend frames)
  useEffect(() => {
    const video = videoRef.current
    if (!isAppVisible || userPaused) {
      attachStream(frameStream ?? null)
      video?.pause()
    } else if (frameStream) {
      stopCapture()
      attachStream(frameStream)
      video?.play().catch(() => {})
    } else {
      startCapture(currentScreen?.id ?? null)
    }

    return () => {
      stopCapture()
    }
  }, [frameStream, currentScreen, isAppVisible, userPaused, startCapture, stopCapture, attachStream])

  const hasScreens = screens.length > 1

  return (
    <div className="preview-pane">
      {/* Monitor-selector bar — always shown when at least one screen is known */}
      {hasScreens && (
        <div className="preview-screen-bar">
          <span className="preview-screen-label">Screen:</span>
          {screens.map((s, i) => (
            <button
              key={s.id}
              className={`screen-btn${currentScreen?.id === s.id ? ' active' : ''}`}
              onClick={() => onScreenChange(s)}
              title={s.name}
            >
              {i + 1}
            </button>
          ))}
        </div>
      )}

       {/* Live capture frame — red border signals "this is what's being captured" */}
        <div 
          className="preview-container"
          ref={containerRef}
        >
        <video ref={videoRef} className="preview-video" autoPlay muted playsInline />
        {/* LIVE / PAUSED badge — shown once a stream is active */}
        {currentScreen && (
          <div className={`preview-live-badge${paused ? ' is-paused' : ''}`}>
            {paused ? 'PAUSED' : 'LIVE'}
          </div>
        )}
        {!currentScreen && (
          <div className="preview-placeholder">Waiting for display…</div>
        )}
        {/* Play / pause toggle — visible on hover, always visible when paused */}
        {currentScreen && (
          <button
            className={`preview-play-btn${paused ? ' is-paused' : ''}`}
            onClick={togglePlayPause}
            title={paused ? 'Resume preview' : 'Pause preview'}
          >
            {paused ? (
              /* Play triangle */
              <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                <polygon points="6,3 20,12 6,21" />
              </svg>
            ) : (
              /* Pause bars */
              <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                <rect x="5" y="4" width="4" height="16" rx="1" />
                <rect x="15" y="4" width="4" height="16" rx="1" />
              </svg>
            )}
          </button>
        )}
      </div>

    </div>
  )
}
