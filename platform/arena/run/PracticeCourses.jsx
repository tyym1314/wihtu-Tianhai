import {t as $t} from '../shared/i18n.mjs';
import React from 'react';
import './practice-courses.css';
export default function PracticeCourses({capability,value,onChange,disabled,locale='zh'}){
 const selected=capability.courses.find(c=>c.id===value)||capability.courses.find(c=>c.id===capability.default_course_id);
 const zh=locale==='zh',ar=locale==='ar',pace=zh?[$t("入门"),$t("进阶"),$t("挑战")]:ar?['مبتدئ','متوسط','متقدم']:['Beginner','Intermediate','Challenge'];
 return <div className="run-practice-courses" data-testid="run-practice-courses" dir={ar?'rtl':'ltr'}>
  <label htmlFor="run-practice-course">{zh?$t("免费练习课程"):ar?'مسار التدريب المجاني':'Free practice course'}<span>{pace[selected.difficulty-1]} · {selected.difficulty}/3</span></label>
  <select id="run-practice-course" value={selected.id} disabled={disabled} onChange={e=>onChange(e.target.value)}>
   {[1,2,3].map(level=><optgroup key={level} label={`${pace[level-1]} · ${level}/3`}>{capability.courses.filter(c=>c.difficulty===level).map(c=><option key={c.id} value={c.id}>{c.title[locale]||c.title.en}</option>)}</optgroup>)}
  </select>
  <small>{zh?$t("上滑跳跃 · 下滑滑铲 · 左右滑动换道。仅用于下方免费 BOT 练习。"):ar?'اسحب للأعلى للقفز وللأسفل للانزلاق وجانبياً لتغيير المسار. للتدريب المجاني فقط.':'Swipe up to jump, down to slide, sideways to change lanes. Free BOT practice only.'}</small>
 </div>;
}
