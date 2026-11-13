import {DEFAULT,resolveAvailabilitySchedule,policySlots} from './policy.js';
import {normalizeDurationOptions,selectDuration} from './durations.js';
/** Local layout examples only. Never consult provider availability or mutate a booking. */
/** `duration` overlays one of the draft's allowed lengths; omitted means the default. */
export function draftPreview(settings,draft,now=Date.now(),duration=undefined){
 const schedules=settings.availabilitySchedules||[],config={...DEFAULT,...draft,...resolveAvailabilitySchedule(draft,schedules,settings.defaultAvailabilityScheduleId),avatarImage:settings.profile?.avatarImage||null,bannerImage:settings.profile?.bannerImage||null};
 config.durationOptions=normalizeDurationOptions(draft.durationOptions??null,draft.duration);config.duration=selectDuration({duration:draft.duration,durationOptions:config.durationOptions},duration);
 config.team=draft.teamScheduling?{mode:draft.teamScheduling.mode,hosts:draft.teamScheduling.hosts.map(h=>({id:h.id,name:h.name}))}:null;
 const linkSlots=policySlots(config,now);
 if(!config.team)return {config,slots:linkSlots};
 const eligible=new Map(draft.teamScheduling.hosts.map(host=>{const hours=schedules.find(s=>s.id===host.scheduleId),policy=hours?{...config,zone:hours.zone,weeklyHours:hours.weeklyHours,dateOverrides:hours.dateOverrides}:config;return [host.id,new Set(policySlots(policy,now).map(s=>s.start))];}));
 const slots=linkSlots.map(slot=>({...slot,hostIds:config.team.hosts.filter(h=>eligible.get(h.id).has(slot.start)).map(h=>h.id)})).filter(slot=>config.team.mode==='all'?slot.hostIds.length===config.team.hosts.length:slot.hostIds.length>0);
 return {config,slots};
}
