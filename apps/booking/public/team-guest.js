const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function teamSlots(slots,team,selectedHostId='',original=null){
 const assigned=original?.assignedHosts?.map(h=>h.id)||[];
 if(assigned.length){if(!team||team.mode!==original.teamMode||assigned.some(id=>!team.hosts?.some(h=>h.id===id))||original.teamMode==='all'&&team.hosts.length!==assigned.length)return [];return slots.filter(s=>Array.isArray(s.hostIds)&&assigned.every(id=>s.hostIds.includes(id)));}
 if(!team)return slots;if(!['any','choose','all'].includes(team.mode)||!Array.isArray(team.hosts))return [];
 if(team.mode==='choose'&&!team.hosts.some(h=>h.id===selectedHostId))return [];
 return slots.filter(s=>Array.isArray(s.hostIds)&&(team.mode==='all'?team.hosts.length&&team.hosts.every(h=>s.hostIds.includes(h.id)):team.hosts.some(h=>s.hostIds.includes(h.id)))&&(team.mode!=='choose'||s.hostIds.includes(selectedHostId)));
}
export function guestTeamMarkup(team,selectedHostId,original){
 if(original?.assignedHosts?.length)return `<p class="guest-hosts">With ${esc(original.assignedHosts.map(h=>h.name).join(', '))}</p>`;
 if(!team)return '';
 if(team.mode==='all')return `<p class="guest-hosts">With ${esc(team.hosts.map(h=>h.name).join(', '))}</p>`;
 if(team.mode!=='choose'||!selectedHostId)return '';
 return `<div class="guest-host-picker"><label for="guest-team-host">Meet with</label><select id="guest-team-host"><option value="">Choose a host</option>${team.hosts.map(h=>`<option value="${esc(h.id)}" ${h.id===selectedHostId?'selected':''}>${esc(h.name)}</option>`).join('')}</select></div>`;
}
export function guestHostChoices(team){return `<section class="calendar-pane team-host-choice" aria-label="Choose a host"><h2>Choose a host</h2><div class="guest-host-choices">${team.hosts.map(h=>`<button type="button" data-choose-host="${esc(h.id)}"><span aria-hidden="true">${esc(h.name.slice(0,1))}</span><strong>${esc(h.name)}</strong><span aria-hidden="true">→</span></button>`).join('')}</div></section>`;}
