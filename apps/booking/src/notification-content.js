import {followUpContent} from '../public/followup.js';
const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const plain = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
function subjectText(value) {
  let result = '', bytes = 0;
  for (const char of plain(value)) { const size = new TextEncoder().encode(char).length; if (bytes + size > 500) break; result += char; bytes += size; }
  return result;
}
function safeLink(value) {
  const url = new URL(value);
  if (url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) throw Error('Invalid notification link');
  return url.href;
}
function time(value, zone) {
  if (!Number.isSafeInteger(value) || !Number.isFinite(new Date(value).valueOf())) throw Error('Invalid notification time');
  return new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(value);
}
/** Trusted server-side content only; no remote assets or tracking. Recipient and
 * provider identity belong to the durable job, never to this presentation layer. */
export function bookingNotificationContent({ booking: b, kind, link, hostName }) {
  const title = plain(b.title) || 'Meeting', host = plain(hostName) || 'Your host';
  let zone = b.timeZone || b.config?.zone || 'UTC';
  try { new Intl.DateTimeFormat('en-GB', {timeZone: zone}); } catch { zone = 'UTC'; }
  const sameDay = new Intl.DateTimeFormat('en-CA', {timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'});
  const end = sameDay.format(b.start) === sameDay.format(b.end) ? new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(b.end) : time(b.end,zone);
  const when = `${time(b.start, zone)}–${end} (${zone})`;
  const requested = kind === 'approval_requested_host' || kind === 'approval_requested_guest';
  const deadline = requested ? time(b.approvalExpiresAt, zone) : '';
  let subject, heading, message, action;
  switch (kind) {
    case 'approval_requested_host':
      subject = `Booking request: ${title}`; heading = 'New booking request';
      message = `${plain(b.name) || 'A guest'} (${plain(b.email)}) requested this meeting. Review it before ${deadline} (${zone}). The time is held until then; no calendar invitation has been sent.`;
      action = 'Review request'; break;
    case 'approval_requested_guest':
      subject = `Request received: ${title}`; heading = 'Your request is waiting for approval';
      message = `${host} will review your request. This meeting is not confirmed. Your time is held until ${deadline} (${zone}). If approved, you’ll receive a calendar invitation.`;
      action = 'View request'; break;
    case 'rejected':
      subject = `Request declined: ${title}`; heading = 'Your booking request was declined';
      message = 'This meeting was not booked. No calendar invitation was created.';
      action = 'View request'; break;
    case 'expired':
      subject = `Request expired: ${title}`; heading = 'Your booking request expired';
      message = 'The request was not approved before its deadline. The time is no longer held, and no calendar invitation was created.';
      action = 'Choose another time'; break;
    case 'confirmed':
      subject = `${title}: confirmed`; heading = 'Your meeting is confirmed';
      message = 'Your booking is confirmed. You can review the details or change your booking below.';
      action = 'Manage booking'; break;
    case 'cancelled':
      subject = `${title}: cancelled`; heading = 'Your booking was cancelled';
      message = 'This booking is cancelled. You can review its details below.';
      action = 'View booking'; break;
    case 'follow_up': {
      const custom=followUpContent(b.config,{guest_name:plain(b.name)||'there',meeting_title:title,host_name:host});
      subject=custom.subject;heading='Following up';message=custom.body;action='View booking';break;
    }
    case 'reminder':
      subject = `${title}: reminder`; heading = 'Your upcoming meeting';
      message = 'Here are the details for your upcoming meeting.';
      action = 'View booking'; break;
    default: throw Error('Invalid notification kind');
  }
  const href = safeLink(link), reason = kind === 'rejected' ? plain(b.rejectionReason).slice(0,500) : '';
  const lines = [heading, title, when, message, ...(reason ? [`Reason: ${reason}`] : []), `${action}: ${href}`];
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f6f6f5;color:#202020;font-family:Arial,Helvetica,sans-serif"><table role="presentation" style="width:100%;border-collapse:collapse"><tr><td style="padding:40px 20px"><table role="presentation" style="width:100%;max-width:560px;margin:0 auto;border-collapse:collapse;background:#fff;border:1px solid #e6e6e4;border-radius:12px"><tr><td style="padding:32px"><h1 style="font-size:23px;line-height:1.3;margin:0 0 24px">${escapeHTML(heading)}</h1><h2 style="font-size:18px;margin:0 0 10px">${escapeHTML(title)}</h2><p style="font-size:14px;line-height:1.6;margin:0 0 24px;color:#555">${escapeHTML(when)}</p><p style="font-size:15px;line-height:1.6;margin:0 0 24px">${escapeHTML(message).replace(/\n/g,'<br>')}</p>${reason ? `<p style="font-size:15px;line-height:1.6">${escapeHTML(reason)}</p>` : ''}<a href="${escapeHTML(href)}" style="display:inline-block;background:#222;color:#fff;padding:13px 20px;border-radius:7px;text-decoration:none;font-size:15px;font-weight:bold">${escapeHTML(action)}</a></td></tr></table></td></tr></table></body></html>`;
  return { subject: subjectText(subject), text: lines.join('\n\n'), html };
}
