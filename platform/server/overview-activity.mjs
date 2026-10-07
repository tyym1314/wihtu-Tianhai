import {pool} from './db.mjs';
import {fail} from './security.mjs';

export function activityTimeZone(req){
 const zone=req.headers['x-oasis-timezone']??'UTC';
 if(typeof zone!=='string'||zone.length>64)fail(400,'INVALID_TIME_ZONE','无效的时区');
 try{new Intl.DateTimeFormat('en-US',{timeZone:zone});}catch{fail(400,'INVALID_TIME_ZONE','无效的时区');}
 return zone;
}

export async function migrateOverviewActivity(){
 await pool.query('CREATE INDEX IF NOT EXISTS gp_cycles_created_at ON gp_cycles(created_at)');
 await pool.query('CREATE INDEX IF NOT EXISTS pvp_rooms_created_at ON pvp_rooms(created_at)');
}

export async function overviewActivity(timeZone,partnerId=null){
 const rows=(await pool.query(`
  WITH bounds AS (
   SELECT (now() AT TIME ZONE $1)::date AS today
  ), calendar AS (
   SELECT (bounds.today - days.ago)::date AS day
   FROM bounds CROSS JOIN generate_series(0,6) AS days(ago)
  ), activity AS (
   SELECT (c.created_at AT TIME ZONE $1)::date AS day,count(*) AS amount
   FROM gp_cycles c CROSS JOIN bounds
   WHERE c.created_at >= ((bounds.today - 6)::timestamp AT TIME ZONE $1)
    AND c.created_at < ((bounds.today + 1)::timestamp AT TIME ZONE $1)
    AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM gp_apps a WHERE a.id=c.app_id AND a.partner_id=$2))
   GROUP BY 1
   UNION ALL
   SELECT (r.created_at AT TIME ZONE $1)::date AS day,count(*) AS amount
   FROM pvp_rooms r CROSS JOIN bounds
   WHERE r.created_at >= ((bounds.today - 6)::timestamp AT TIME ZONE $1)
    AND r.created_at < ((bounds.today + 1)::timestamp AT TIME ZONE $1)
    AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM gp_apps a WHERE a.id=r.app_id AND a.partner_id=$2))
   GROUP BY 1
  )
  SELECT to_char(calendar.day,'YYYY-MM-DD') AS date,COALESCE(sum(activity.amount),0)::int AS count
  FROM calendar LEFT JOIN activity ON activity.day=calendar.day
  GROUP BY calendar.day ORDER BY calendar.day
 `,[timeZone,partnerId])).rows;
 return {time_zone:timeZone,days:rows};
}
