INSERT INTO traffic_countings (iddevice,device_name,starthour,created_at,updated_at,"data") VALUES
	 ('PB1_CCTV_02','R. Utama Perhiasan','2026-07-06 23:00:00+07','2026-07-07 00:01:30.908479+07','2026-07-07 00:01:30.908479+07','{"cctv_people_in": 0, "cctv_people_out": 0, "cctv_people_total_in": "2553", "cctv_people_total_out": "0"}'),
	 ('PB1_CCTV_02','R. Utama Perhiasan','2026-07-07 00:00:00+07','2026-07-07 01:01:30.730889+07','2026-07-07 01:01:30.730889+07','{"cctv_people_in": 6, "cctv_people_out": 0, "cctv_people_total_in": "6", "cctv_people_total_out": "0"}'),
	 ('PB1_CCTV_02','R. Utama Perhiasan','2026-07-07 01:00:00+07','2026-07-07 02:01:30.601377+07','2026-07-07 02:01:30.601377+07','{"cctv_people_in": 0, "cctv_people_out": 0, "cctv_people_total_in": "6", "cctv_people_total_out": "0"}'),
	 ('PB1_CCTV_02','R. Utama Perhiasan','2026-07-07 02:00:00+07','2026-07-07 03:01:30.475057+07','2026-07-07 03:01:30.475057+07','{"cctv_people_in": 0, "cctv_people_out": 0, "cctv_people_total_in": "6", "cctv_people_total_out": "0"}'),
	 ('PB1_CCTV_02','R. Utama Perhiasan','2026-07-07 03:00:00+07','2026-07-07 04:01:30.324904+07','2026-07-07 04:01:30.324904+07','{"cctv_people_in": 0, "cctv_people_out": 0, "cctv_people_total_in": "6", "cctv_people_total_out": "0"}'),
	 ('PB1_CCTV_02','R. Utama Perhiasan','2026-07-07 04:00:00+07','2026-07-07 05:01:30.182675+07','2026-07-07 05:01:30.182675+07','{"cctv_people_in": 0, "cctv_people_out": 0, "cctv_people_total_in": "6", "cctv_people_total_out": "0"}'),
	 ('PB1_CCTV_02','R. Utama Perhiasan','2026-07-07 05:00:00+07','2026-07-07 06:01:30.057067+07','2026-07-07 06:01:30.057067+07','{"cctv_people_in": 5, "cctv_people_out": 0, "cctv_people_total_in": "11", "cctv_people_total_out": "0"}'),
	 ('PB1_CCTV_02','R. Utama Perhiasan','2026-07-07 06:00:00+07','2026-07-07 07:01:29.928505+07','2026-07-07 07:01:29.928505+07','{"cctv_people_in": 1, "cctv_people_out": 0, "cctv_people_total_in": "12", "cctv_people_total_out": "0"}'),
	 ('PB1_CCTV_02','R. Utama Perhiasan','2026-07-07 07:00:00+07','2026-07-07 08:01:29.800686+07','2026-07-07 08:01:29.800686+07','{"cctv_people_in": 1, "cctv_people_out": 0, "cctv_people_total_in": "13", "cctv_people_total_out": "0"}'),
	 ('PB1_CCTV_02','R. Utama Perhiasan','2026-07-07 08:00:00+07','2026-07-07 09:01:29.690191+07','2026-07-07 09:01:29.690191+07','{"cctv_people_in": 176, "cctv_people_out": 0, "cctv_people_total_in": "189", "cctv_people_total_out": "0"}');
INSERT INTO traffic_countings (iddevice,device_name,starthour,created_at,updated_at,"data") VALUES
	 ('PB1_CCTV_02','R. Utama Perhiasan','2026-07-07 09:00:00+07','2026-07-07 10:01:29.548409+07','2026-07-07 10:01:29.548409+07','{"cctv_people_in": 298, "cctv_people_out": 0, "cctv_people_total_in": "517", "cctv_people_total_out": "0"}'),
	 ('PB1_CCTV_02','R. Utama Perhiasan','2026-07-07 10:00:00+07','2026-07-07 11:01:29.382829+07','2026-07-07 11:01:29.382829+07','{"cctv_people_in": 102, "cctv_people_out": 0, "cctv_people_total_in": "619", "cctv_people_total_out": "0"}');

-- Dummy data for CCTV_EPW_S21 (CCTV Clover Selatan) — one INSERT per detection
-- case, 10 hourly rows each (2026-07-10 00:00 -> 09:00). Randomized per-hour
-- values with running daily totals (each _total = previous total + that
-- hour's value) — shape/format test rows, not real counts.

-- Case: APD
INSERT INTO traffic_countings (iddevice,device_name,starthour,created_at,updated_at,"data") VALUES
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 00:00:00+07','2026-07-10 01:01:00+07','2026-07-10 01:01:00+07','{"cctv_apd": 1, "cctv_apd_total": 1}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 01:00:00+07','2026-07-10 02:01:00+07','2026-07-10 02:01:00+07','{"cctv_apd": 0, "cctv_apd_total": 1}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 02:00:00+07','2026-07-10 03:01:00+07','2026-07-10 03:01:00+07','{"cctv_apd": 4, "cctv_apd_total": 5}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 03:00:00+07','2026-07-10 04:01:00+07','2026-07-10 04:01:00+07','{"cctv_apd": 3, "cctv_apd_total": 8}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 04:00:00+07','2026-07-10 05:01:00+07','2026-07-10 05:01:00+07','{"cctv_apd": 3, "cctv_apd_total": 11}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 05:00:00+07','2026-07-10 06:01:00+07','2026-07-10 06:01:00+07','{"cctv_apd": 2, "cctv_apd_total": 13}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 06:00:00+07','2026-07-10 07:01:00+07','2026-07-10 07:01:00+07','{"cctv_apd": 1, "cctv_apd_total": 14}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 07:00:00+07','2026-07-10 08:01:00+07','2026-07-10 08:01:00+07','{"cctv_apd": 8, "cctv_apd_total": 22}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 08:00:00+07','2026-07-10 09:01:00+07','2026-07-10 09:01:00+07','{"cctv_apd": 1, "cctv_apd_total": 23}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 09:00:00+07','2026-07-10 10:01:00+07','2026-07-10 10:01:00+07','{"cctv_apd": 6, "cctv_apd_total": 29}')
ON CONFLICT (iddevice, starthour) DO UPDATE
    SET data = traffic_countings.data || EXCLUDED.data,
        updated_at = EXCLUDED.updated_at;

-- Case: Intrusion
INSERT INTO traffic_countings (iddevice,device_name,starthour,created_at,updated_at,"data") VALUES
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 00:00:00+07','2026-07-10 01:01:00+07','2026-07-10 01:01:00+07','{"cctv_intrusion": 0, "cctv_intrusion_total": 0}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 01:00:00+07','2026-07-10 02:01:00+07','2026-07-10 02:01:00+07','{"cctv_intrusion": 0, "cctv_intrusion_total": 0}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 02:00:00+07','2026-07-10 03:01:00+07','2026-07-10 03:01:00+07','{"cctv_intrusion": 0, "cctv_intrusion_total": 0}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 03:00:00+07','2026-07-10 04:01:00+07','2026-07-10 04:01:00+07','{"cctv_intrusion": 1, "cctv_intrusion_total": 1}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 04:00:00+07','2026-07-10 05:01:00+07','2026-07-10 05:01:00+07','{"cctv_intrusion": 1, "cctv_intrusion_total": 2}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 05:00:00+07','2026-07-10 06:01:00+07','2026-07-10 06:01:00+07','{"cctv_intrusion": 0, "cctv_intrusion_total": 2}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 06:00:00+07','2026-07-10 07:01:00+07','2026-07-10 07:01:00+07','{"cctv_intrusion": 1, "cctv_intrusion_total": 3}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 07:00:00+07','2026-07-10 08:01:00+07','2026-07-10 08:01:00+07','{"cctv_intrusion": 3, "cctv_intrusion_total": 6}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 08:00:00+07','2026-07-10 09:01:00+07','2026-07-10 09:01:00+07','{"cctv_intrusion": 1, "cctv_intrusion_total": 7}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 09:00:00+07','2026-07-10 10:01:00+07','2026-07-10 10:01:00+07','{"cctv_intrusion": 3, "cctv_intrusion_total": 10}')
ON CONFLICT (iddevice, starthour) DO UPDATE
    SET data = traffic_countings.data || EXCLUDED.data,
        updated_at = EXCLUDED.updated_at;

-- Dummy data for PB1_CCTV_9 (Area Pabrik 1 pemeriksaan) — Intrusion case,
-- into the LOCAL intrusion_hourly table itself (raw per-label counters, same
-- shape detection/intrusion.py writes via increment_hourly), NOT the central
-- traffic_countings table. Single hourly row 12:00-13:00. device_id is a
-- throwaway UUID (this device doesn't have a real one on record) — swap it
-- for the real device_id if PB1_CCTV_9 already exists in this DB.
INSERT INTO intrusion_hourly (device_id, device_code, device_name, hour_start, data, updated_at, is_synced) VALUES
	 ('8ab00286-b378-48b4-9acb-2da83e2c1804','PB1_CCTV_9','Area Pabrik 1 pemeriksaan','2026-07-10 12:00:00+07','{"intrusion": 3, "unique_persons": 3}','2026-07-10 13:01:00+07', false)
ON CONFLICT (device_id, hour_start) DO UPDATE
    SET data = intrusion_hourly.data || EXCLUDED.data,
        updated_at = EXCLUDED.updated_at;

-- Case: Face (insider/intruder)
INSERT INTO traffic_countings (iddevice,device_name,starthour,created_at,updated_at,"data") VALUES
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 00:00:00+07','2026-07-10 01:01:00+07','2026-07-10 01:01:00+07','{"cctv_face_insider": 23, "cctv_face_intruder": 0, "cctv_face_total_insider": 23, "cctv_face_total_intruder": 0}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 01:00:00+07','2026-07-10 02:01:00+07','2026-07-10 02:01:00+07','{"cctv_face_insider": 13, "cctv_face_intruder": 0, "cctv_face_total_insider": 36, "cctv_face_total_intruder": 0}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 02:00:00+07','2026-07-10 03:01:00+07','2026-07-10 03:01:00+07','{"cctv_face_insider": 5, "cctv_face_intruder": 3, "cctv_face_total_insider": 41, "cctv_face_total_intruder": 3}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 03:00:00+07','2026-07-10 04:01:00+07','2026-07-10 04:01:00+07','{"cctv_face_insider": 10, "cctv_face_intruder": 0, "cctv_face_total_insider": 51, "cctv_face_total_intruder": 3}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 04:00:00+07','2026-07-10 05:01:00+07','2026-07-10 05:01:00+07','{"cctv_face_insider": 18, "cctv_face_intruder": 2, "cctv_face_total_insider": 69, "cctv_face_total_intruder": 5}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 05:00:00+07','2026-07-10 06:01:00+07','2026-07-10 06:01:00+07','{"cctv_face_insider": 15, "cctv_face_intruder": 2, "cctv_face_total_insider": 84, "cctv_face_total_intruder": 7}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 06:00:00+07','2026-07-10 07:01:00+07','2026-07-10 07:01:00+07','{"cctv_face_insider": 13, "cctv_face_intruder": 4, "cctv_face_total_insider": 97, "cctv_face_total_intruder": 11}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 07:00:00+07','2026-07-10 08:01:00+07','2026-07-10 08:01:00+07','{"cctv_face_insider": 9, "cctv_face_intruder": 2, "cctv_face_total_insider": 106, "cctv_face_total_intruder": 13}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 08:00:00+07','2026-07-10 09:01:00+07','2026-07-10 09:01:00+07','{"cctv_face_insider": 11, "cctv_face_intruder": 0, "cctv_face_total_insider": 117, "cctv_face_total_intruder": 13}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 09:00:00+07','2026-07-10 10:01:00+07','2026-07-10 10:01:00+07','{"cctv_face_insider": 15, "cctv_face_intruder": 3, "cctv_face_total_insider": 132, "cctv_face_total_intruder": 16}')
ON CONFLICT (iddevice, starthour) DO UPDATE
    SET data = traffic_countings.data || EXCLUDED.data,
        updated_at = EXCLUDED.updated_at;

-- Case: Smoke & Fire
INSERT INTO traffic_countings (iddevice,device_name,starthour,created_at,updated_at,"data") VALUES
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 00:00:00+07','2026-07-10 01:01:00+07','2026-07-10 01:01:00+07','{"cctv_smoke": 2, "cctv_fire": 0, "cctv_smoke_total": 2, "cctv_fire_total": 0}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 01:00:00+07','2026-07-10 02:01:00+07','2026-07-10 02:01:00+07','{"cctv_smoke": 0, "cctv_fire": 0, "cctv_smoke_total": 2, "cctv_fire_total": 0}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 02:00:00+07','2026-07-10 03:01:00+07','2026-07-10 03:01:00+07','{"cctv_smoke": 1, "cctv_fire": 0, "cctv_smoke_total": 3, "cctv_fire_total": 0}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 03:00:00+07','2026-07-10 04:01:00+07','2026-07-10 04:01:00+07','{"cctv_smoke": 0, "cctv_fire": 0, "cctv_smoke_total": 3, "cctv_fire_total": 0}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 04:00:00+07','2026-07-10 05:01:00+07','2026-07-10 05:01:00+07','{"cctv_smoke": 2, "cctv_fire": 1, "cctv_smoke_total": 5, "cctv_fire_total": 1}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 05:00:00+07','2026-07-10 06:01:00+07','2026-07-10 06:01:00+07','{"cctv_smoke": 1, "cctv_fire": 0, "cctv_smoke_total": 6, "cctv_fire_total": 1}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 06:00:00+07','2026-07-10 07:01:00+07','2026-07-10 07:01:00+07','{"cctv_smoke": 2, "cctv_fire": 0, "cctv_smoke_total": 8, "cctv_fire_total": 1}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 07:00:00+07','2026-07-10 08:01:00+07','2026-07-10 08:01:00+07','{"cctv_smoke": 2, "cctv_fire": 0, "cctv_smoke_total": 10, "cctv_fire_total": 1}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 08:00:00+07','2026-07-10 09:01:00+07','2026-07-10 09:01:00+07','{"cctv_smoke": 1, "cctv_fire": 1, "cctv_smoke_total": 11, "cctv_fire_total": 2}'),
	 ('CCTV_EPW_S21','CCTV Clover Selatan','2026-07-10 09:00:00+07','2026-07-10 10:01:00+07','2026-07-10 10:01:00+07','{"cctv_smoke": 2, "cctv_fire": 1, "cctv_smoke_total": 13, "cctv_fire_total": 3}')
ON CONFLICT (iddevice, starthour) DO UPDATE
    SET data = traffic_countings.data || EXCLUDED.data,
        updated_at = EXCLUDED.updated_at;
