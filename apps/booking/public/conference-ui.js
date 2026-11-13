export function meetingLink(booking) {
  if (booking?.conferenceStatus !== 'ready' || typeof booking.meetingUrl !== 'string') return null;
  try {
    const u = new URL(booking.meetingUrl);
    return u.protocol === 'https:' && u.hostname === 'meet.google.com' && !u.port && !u.username && !u.password && !u.search && !u.hash && /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(u.pathname) ? u.href : null;
  } catch { return null; }
}
export function conferenceMarkup(booking) {
  const link = meetingLink(booking);
  if (link) return `<p class="conference-state"><a class="secondary" href="${link}" target="_blank" rel="noopener noreferrer">Join Google Meet ↗</a></p>`;
  if (booking?.conferenceStatus === 'pending') return '<p class="conference-state muted" role="status">Creating your Google Meet link…</p>';
  if (booking?.conferenceStatus === 'failed') return '<p class="conference-state" role="status">The meeting is booked, but its Google Meet link needs attention. Contact the host.</p>';
  return '';
}
