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
export default function PreviewPane({ screens, currentScreen, frameStream, onScreenChange }) {
  const videoRef = useRef(null)
  const internalStreamRef = useRef(null)
  const containerRef = useRef(null)
  const [paused, setPaused] = useState(false)

  // Attach a MediaStream (or null) to the <video> element
  const attachStream = useCallback((stream) => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream ?? null
    }
  }, [])

  // Open a desktop-capture stream for the given desktopCapturer source ID
  const startCapture = useCallback(
    async (sourceId) => {
      // Stop any previously running internal stream
      if (internalStreamRef.current) {
        internalStreamRef.current.getTracks().forEach((t) => t.stop())
        internalStreamRef.current = null
      }

      if (!sourceId) {
        attachStream(null)
        return
      }

      try {
        // Uses the Electron-specific mandatory constraint syntax – the source ID
        // is the one returned by desktopCapturer.getSources() in the main process.
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
        internalStreamRef.current = stream
        attachStream(stream)
      } catch (err) {
        // Expected in plain-browser dev (no Electron / no desktopCapturer source)
        console.warn('PreviewPane: capture unavailable —', err.message)
        attachStream(null)
      }
    },
    [attachStream],
  )

  const togglePlayPause = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      // Resume: restart the capture stream if it was stopped
      if (!internalStreamRef.current && currentScreen?.id) {
        startCapture(currentScreen.id)
      }
      video.play().catch(() => {})
      setPaused(false)
    } else {
      // Pause: stop the capture stream to save GPU memory
      if (internalStreamRef.current) {
        internalStreamRef.current.getTracks().forEach((t) => t.stop())
        internalStreamRef.current = null
      }
      video.pause()
      setPaused(true)
    }
  }, [currentScreen, startCapture])

  // When an external frameStream is supplied it takes precedence over
  // the internal getUserMedia approach (reserved for Rust backend frames)
  useEffect(() => {
    setPaused(false)
    if (frameStream) {
      if (internalStreamRef.current) {
        internalStreamRef.current.getTracks().forEach((t) => t.stop())
        internalStreamRef.current = null
      }
      attachStream(frameStream)
    } else {
      startCapture(currentScreen?.id ?? null)
    }
  }, [frameStream, currentScreen, startCapture, attachStream])

  // Stop the internal stream when the component unmounts
  useEffect(() => {
    return () => {
      if (internalStreamRef.current) {
        internalStreamRef.current.getTracks().forEach((t) => t.stop())
      }
    }
  }, [])

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
