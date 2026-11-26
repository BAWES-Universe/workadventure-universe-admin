# Orbit 0.5.0: the migrations this release ships

`prisma/migration-manifest.json` is the exact list of migration directories that deploy with 0.5.0. This page explains it. The list below is written from
the directory by `node scripts/migration-manifest.mjs --write`, and `__tests__/migrations/release-manifest.test.ts` fails when the directory, the manifest
or this list drift apart, so what a reviewer reads is what `prisma migrate deploy` runs.

- **Production today (v0.3.44):** 77 migrations (`baseline` in the manifest).
- **0.5.0 ships:** the baseline plus every migration after it, in the list at the end of this page. Prisma applies the ones a database has not run, in name order.
- `prisma migrate deploy` is the only command used to deploy. It never resets, never drops anything that is not in a migration's own SQL, and stops at the first
  migration that fails (a failed one is recorded and the next deploy refuses until it is looked at).

## Superseded: `20261119135000_app_key_holds` (NOT shipped)

The standalone #1013 branch (commit `13cec427`) added a table `app_key_holds`: one row per try on a key form, expiring by itself. The release does not use it.
Tries on a key form are counted by the form's reserved epoch (`20261119100000_app_key_request_reservation_epoch`, `app_key_requests.reserved_epoch`, money
review O1), and a try that lapses counts as used. So the migration directory is **not** in the shipping tree, no Prisma model reads the table, and no code
writes it.

If an environment ever applied the standalone migration (a developer database or a staging copy; production did not, it is on v0.3.44):

1. Look first: `select migration_name, finished_at from _prisma_migrations where migration_name = '20261119135000_app_key_holds';`
2. Deploy as usual. `prisma migrate deploy` ignores a recorded migration that is no longer in the directory and applies what is missing. This is tested
   (`__tests__/migrations/upgrade-from-populated-db.test.ts`: a database that applied the standalone migration, with a key form holding a hold row).
3. What stays behind is the table `app_key_holds` (and its foreign key to `app_key_requests`), unused. `prisma migrate diff` shows exactly that and nothing
   else. It can be dropped by hand once nobody needs the rows: `DROP TABLE "app_key_holds";`. Nothing ships that does it, on purpose: a release migration
   should not delete a table an operator did not choose to delete.

## Migrations that change or delete rows

Production (v0.3.44) has none of the tables the first group touches, so on production they run against empty tables. They matter for a database that
already ran part of the 0.5.0 work (development, staging): there they run against real rows, and the upgrade test seeds exactly those rows.

| Migration | What it does to rows already there |
|---|---|
| `20261117190000_computer_results_owned` | Fills `owner_id`/`maker_name`/`job_title` of result files from their job, **deletes** result files that have no job to take them from, then makes the three columns required |
| `20261117190000_code_jobs_owned_results` | **Drops** `code_job_outputs` (results are now owned files) |
| `20261117200000_computer_results_shared` | **Drops** the columns `storage_key` and `purged_at` of `computer_job_files` |
| `20261117150000_computer_report_back` | Marks every ended computer job as already told |
| `20261118020000_make_tried_at`, `20261118100000_code_jobs_closure_check` | Mark Brick computers and closed code jobs as already tried / checked |
| `20261119100000_task_receipt_lease` | Gives each running receipt (not a computer's) a fresh 10-minute lease; sets `outcome` from `state` on ended ones |
| `20261119120000_meter_allowance_history` | Writes the allowance saved today into `meter_allowance_changes` (from 1970), and a later-dated one from its day |
| `20261114120000_visiting_bricks_on_by_default` | Sets `allow_visiting_bricks` on every universe |
| `20261120090000_archive_deletion_since` | Marks copies already `superseded` as waiting for deletion from the moment of the migration |

Three migrations build an index and say so in their own header: `20261119090001` and `20261119090002` use `CREATE INDEX CONCURRENTLY` (one statement each, so
Prisma runs them outside a transaction and checkouts in flight are never blocked), and `20261119230000_ai_usage_report_key` builds a **non-concurrent** unique
index on `bots_ai_usage`, which blocks writes to that table while it builds: check the table's size on production first (the release checklist has it).

## One owner for each obligation (old and new versions side by side)

While 0.5.0 rolls out, the old version and the new one run together on one database. An obligation (money that must be given back, a receipt that must
settle, a file that must be deleted) is kept once only if exactly one piece of code may write its record, and that code claims the record **in the
database** (a lock, a unique key, a lease, a generation), never in a process, a version or a timer: whichever server gets there first wins, and the other
finds the claim. `__tests__/lib/obligation-owners.test.ts` fails when a second file starts writing any record below (through its model or a raw statement), or
when a path that must share one writer stops sharing it. Adding a writer is allowed, on purpose, by changing that test and this table together.

| Obligation | Its record | The only writer | How it is claimed |
|---|---|---|---|
| An Instant run (hold, send, settlement) | `instant_runs` | `lib/instant/executor.ts` | advisory lock `instant:run:<id>` on every step; unique `run_key` |
| An Instant give-back owed | `instant_refunds` | `lib/instant/executor.ts` | unique `refund_key`; retried until the books confirm; the sweep asks the never-asked and longest-ago first |
| An Instant run's line in the books | `meter_events` (`instant:<run id>`) | `reportInstantRunIn` in `lib/instant/report.ts`, for the first settlement, a later confirmation and the repair alike | unique event id, written or corrected under the run's own lock |
| A lease on someone's allowance | `meter_reservations` | `lib/meter-allowance.ts`, `lib/computer-calls.ts` | unique reservation key; the pool lock is held to take, renew, settle or release a lease, and the state is read after it is held. `lib/computer-calls.ts` writes one field only, the stretch a model call was admitted in, once (`stretch IS NULL`), under the job's cutoff lock |
| A receipt that must always settle | `task_receipts` | `lib/task-receipts.ts` (and `lib/brick-purge.ts`, which ends a purged Brick's open receipts) | advisory lock per task, a lease the bot server renews, a generation so a stale close cannot end a newer turn |
| Tries on a key form | `app_key_requests` | `lib/app-direct/connect.ts` (and the purge) | the form row and its reserved epoch |
| A checkout order and its moves | `app_page_orders`, `app_page_order_events` | `lib/app-direct/pay.ts` | unique (page, buyer, wish); every move written as an event |
| A computer job's credit given back | `meter_events` of the job | `giveBackComputerCredit`, called only by `giveBackModelCalls` (the end of a job, a late call and the sweep all go through it) | advisory lock `computer:giveback:<person>`; the same draw under the same key is one draw |
| A computer job | `computer_jobs` | eight files, one per kind of column: `lib/computer.ts` (state, ending, time), `lib/computer-job-controls.ts` (a person's pause, resume, do-this-first and cancel of one job, each one transaction under the job's cutoff lock with its row locked), `lib/computer-job-notes.ts` (a note's number and its sent mark, under the job's lock and owner epoch), `lib/computer-limit-pause.ts` (a paused job carried on by itself when more time arrives, a conditional flip under the job's locks), `lib/computer-broker.ts` (model calls, claims), `lib/computer-report.ts` (the report to the person), `lib/computer-visits.ts`, and `lib/computer-giveback.ts` for whether a failed job was given back (its ending mark and whether it counts against the person's bound, under the person's give-back lock) | one writer per running job (`computer_jobs_one_writer`), claim columns for key and turn, unique `run_id` per Brick |
| Whether a failed computer job is given back, and why | `computer_give_back_decisions` | `lib/computer-giveback.ts` | one row per job (primary key); every write under the person's advisory lock `computer:giveback:<person>`; a held decision is decided again by the sweep with a growing wait |
| What the game relay saw go wrong on a job's model calls | `computer_job_faults` | `lib/computer-faults.ts` | unique (job, call); an unsure row may be settled once |
| A refund of credit a failed job drew, owed until the books acknowledge it | `computer_refund_obligations` | `lib/computer-refunds.ts` | unique hold key; the amount and the refund key are fixed when it is written, so every retry is the same refund; it outlives the job and the Brick |
| An effect a job planned outside | `computer_effects` | `lib/computer.ts` | unique (job, effect), planned before it is sent and never repeated |
| A stored copy and the deletion of its object | `computer_archives` | `lib/computer-archives.ts` (and `lib/computer-cold.ts`, which marks a proof that failed inside its own claim) | state guards on every update; the copy is taken for deletion (and its wait written down) before its object is touched; the pack-away claim on the Brick's computer |
| What is left to delete outside for a deleted Brick | `brick_purges`, `bot_file_removals` | `lib/brick-purge.ts`; `lib/brick-files.ts` | one row per Brick / per file (primary key, unique file); retried with a next-try time |
| A voice note's files at the provider | `voice_note_cleanups` | `lib/voice-note-cleanups.ts` | unique (provider, kind, object), a lease per row |
| A usage report | `bots_ai_usage` | `app/api/bots/ai-usage/route.ts` | one `report_key` per report, written once |
| Extra usage granted; an App use counted | `meter_grants`, `app_uses` | `lib/meter-grants.ts`; `lib/app-uses.ts` | unique grant key; advisory lock per connection and universe |

What an older version can still do to these tables is tested in `__tests__/migrations/upgrade-from-populated-db.test.ts` ("lets an OLDER worker go on writing"):
the statements it sends keep working against the new columns, which are all nullable or defaulted. Known limits, not changed here:

- A receipt an older worker opens **after** the upgrade has no lease (the new `openReceipt` writes one). The sweep only picks up a `running` Apps receipt that has one,
  so it would settle by its own close and not by the sweep. Production (v0.3.44) has no receipts at all, so this can only arise on an environment that ran an earlier
  version of the work.
- `POST /api/meter/events` accepts any event id from the bot server, including one that begins `instant:` (the family Orbit writes for Instant runs). The game does
  not send one as far as the code that was read shows (the game repository was not searched beyond its default branch); reserving the prefix at that route would make
  the single writer a rule rather than a habit.

## The list

<!-- migrations:start -->
  1. `20251205145742_init`
  2. `20251207200516_add_wam_url_and_auth_to_rooms_remove_from_worlds`
  3. `20251208001747_add_last_ip_address`
  4. `20251208010900_add_is_guest_field`
  5. `20251208202356_remove_universe_member`
  6. `20251208203429_add_room_access_analytics`
  7. `20251211225849_add_visit_card`
  8. `20251215220634_add_membership_invitations`
  9. `20251215230302_update_membership_invitation_unique_constraint`
 10. `20251221021150_add_favorite_indexes`
 11. `20251226041154_add_room_templates`
 12. `20260106023008_add_bots`
 13. `20260106030000_add_bot_audit_fields`
 14. `20260109120000_add_ai_providers`
 15. `20260118154734_add_bot_metrics_and_conversations`
 16. `20260124130600_add_conversation_deduplication_features`
 17. `20260512_avatar_catalog`
 18. `20260626180626_remove_audit_log_fk`
 19. `20260626_fix_scope_id_unique`
 20. `20260628102846_add_bot_mcp_server`
 21. `20260629102707_add_mcp_server_headers`
 22. `20260629123719_add_mcp_test_result_fields`
 23. `20260804013519_add_bot_vision_support`
 24. `20260830000000_vision_provider_model`
 25. `20260926130943_add_user_preferences`
 26. `20260927170736_add_room_access_user_uuid_index`
 27. `20261004101856_player_reports`
 28. `20261005050000_add_bot_tool_timeout`
 29. `20261005140000_add_bot_companion_texture`
 30. `20261007060000_room_access_texture_ids`
 31. `20261011070000_user_avatar_outfit_updated_at`
 32. `20261012100000_user_outfits`
 33. `20261014100000_companion_none_after_outfits`
 34. `20261017180000_roles`
 35. `20261018220000_bot_permissions`
 36. `20261019100000_bot_access_rules`
 37. `20261019120000_bot_reply_caps_optional`
 38. `20261019130000_ai_keys_owner`
 39. `20261019140000_hide_bot_conversations`
 40. `20261019140000_universe_ai_default`
 41. `20261019150000_user_notices`
 42. `20261019160000_ai_key_lends`
 43. `20261019170000_ai_usage_who`
 44. `20261019180000_ai_key_health`
 45. `20261021090000_room_access_relinks`
 46. `20261023180000_ai_models_per_bot`
 47. `20261025180000_push_devices`
 48. `20261025190000_push_gateway`
 49. `20261026090000_ai_usage_price_facts`
 50. `20261026100000_artifacts`
 51. `20261026110000_nearby_shared_items`
 52. `20261027140000_ai_usage_channel_person`
 53. `20261027150000_reply_limits`
 54. `20261027180000_bot_limits`
 55. `20261027200000_unpin_bots_from_providers`
 56. `20261028090000_artifact_media`
 57. `20261028100000_bot_files`
 58. `20261030090000_nearby_shared_with`
 59. `20261030200000_bot_change_delete_permissions`
 60. `20261030210000_bot_tool_settings`
 61. `20261030220000_bot_action_requests`
 62. `20261030230000_voice_settings`
 63. `20261030231000_voice_providers`
 64. `20261030232000_bot_voice`
 65. `20261031000000_personal_voice_keys`
 66. `20261031010000_voice_key_health`
 67. `20261101000000_voice_key_usage`
 68. `20261101010000_voice_key_limits`
 69. `20261102000000_voice_reply_uses`
 70. `20261103210000_voice_default_voice`
 71. `20261104150000_tools_cut`
 72. `20261104170000_allow_more_times`
 73. `20261105110000_tool_signin_expired`
 74. `20261105120000_universe_ownership_offers`
 75. `20261106170000_universe_ai_current_voice_models`
 76. `20261106220000_voice_listen_uses`
 77. `20261108120000_voice_hidden_models`
 78. `20261110140000_usage_greeting`
 79. `20261111110000_bot_without_room`
 80. `20261111130000_artifact_just_you`
 81. `20261111150000_bot_file_seen_by`
 82. `20261111170000_default_brick`
 83. `20261111190000_meter_ledger`
 84. `20261111200000_brick_delete_undo`
 85. `20261111220000_guest_brick`
 86. `20261112080000_brick_items`
 87. `20261112082000_call_rule_bit`
 88. `20261112100000_app_connections`
 89. `20261112100000_memory_item_forgets`
 90. `20261112110000_bot_file_removals`
 91. `20261112120000_brick_computer`
 92. `20261112121000_meter_requests`
 93. `20261112122000_brick_item_delivery`
 94. `20261112123000_visiting_bricks`
 95. `20261112124000_brick_item_held`
 96. `20261112124000_visit_room_since`
 97. `20261112130000_brick_homes`
 98. `20261113090000_brick_goal_ask`
 99. `20261113120000_computer_job_run`
100. `20261113130000_app_catalog`
101. `20261113140000_app_ready_made`
102. `20261113150000_app_lend_team`
103. `20261113180000_voice_note_turns`
104. `20261113203000_voice_note_turns_state_index`
105. `20261114120000_visiting_bricks_on_by_default`
106. `20261114180000_app_direct_keys`
107. `20261114180000_app_share`
108. `20261114180000_brick_delivered_report`
109. `20261114180000_brick_templates`
110. `20261114190000_app_key_calls`
111. `20261114190000_brick_item_paused_by_template`
112. `20261114190000_computer_job_tokens`
113. `20261114200000_app_page_payments`
114. `20261114200000_brick_template_use_needs`
115. `20261114200000_computer_agent_turns`
116. `20261114210000_computer_job_brief`
117. `20261114220000_computer_files_list`
118. `20261115040000_computer_clean_claim_and_stopping`
119. `20261115050000_funding_books`
120. `20261115051000_instant_executor`
121. `20261115060000_app_request_key`
122. `20261115060000_spend_rules_and_task_receipts`
123. `20261115061000_computer_job_ended_by_rule`
124. `20261115070000_app_routes_and_demand`
125. `20261115120000_funding_books_followup`
126. `20261115190000_instant_closed_keys`
127. `20261115200000_instant_run_task_key`
128. `20261116220000_launch_defaults`
129. `20261116230000_app_use_limits`
130. `20261116233000_speech_limits`
131. `20261117000000_computer_reconcile`
132. `20261117010000_computer_job_route`
133. `20261117140000_app_key_request_reserved_tries`
134. `20261117150000_computer_report_back`
135. `20261117160000_brick_purge`
136. `20261117160000_brick_run_now_snooze`
137. `20261117160000_computer_report_files`
138. `20261117160100_brick_met`
139. `20261117170000_code_jobs`
140. `20261117170000_computer_control_transition`
141. `20261117170000_computer_file_cards`
142. `20261117180000_computer_report_delivery`
143. `20261117190000_brick_purge_chat`
144. `20261117190000_code_jobs_owned_results`
145. `20261117190000_computer_results_owned`
146. `20261117200000_computer_job_visits`
147. `20261117200000_computer_results_shared`
148. `20261117210000_voice_reply_seconds`
149. `20261117220000_saved_copy_writes`
150. `20261117230000_cold_storage`
151. `20261118020000_make_tried_at`
152. `20261118100000_code_jobs_closure_check`
153. `20261118110000_computer_hand_over_alive`
154. `20261118120000_code_jobs_nested_tried`
155. `20261118200000_brick_run_universe_ai`
156. `20261119090000_brick_item_failure_notice`
157. `20261119090000_page_order_intents`
158. `20261119090001_page_order_intents_wish_index`
159. `20261119090002_page_order_intents_buyer_index`
160. `20261119100000_app_key_request_reservation_epoch`
161. `20261119100000_spend_rule_fingerprint`
162. `20261119100000_task_receipt_lease`
163. `20261119110000_meter_grant_cancelled`
164. `20261119120000_meter_allowance_history`
165. `20261119130000_voice_note_reply_source`
166. `20261119140000_sign_in_notices_retry`
167. `20261119150000_meter_reservation_terms`
168. `20261119160000_sign_in_generation`
169. `20261119170000_computer_job_claims`
170. `20261119180000_brick_removals`
171. `20261119190000_guest_brick_pending_handover`
172. `20261119200000_computer_first_turn_sent`
173. `20261119210000_computer_turn_unproven`
174. `20261119212000_meter_grant_closed_keys`
175. `20261119220000_instant_refund_released`
176. `20261119221000_instant_refund_last_tried`
177. `20261119230000_ai_usage_report_key`
178. `20261119231000_instant_refund_zero_confirmed`
179. `20261120080000_computer_job_runner_fault`
180. `20261120090000_archive_deletion_since`
181. `20261120110000_task_receipt_failed_outcomes`
182. `20261120120000_computer_job_faults`
183. `20261120120000_page_order_reconcile`
184. `20261120130000_computer_refund_obligations`
185. `20261120140000_computer_fault_run`
186. `20261120140000_page_order_long_wait_index`
187. `20261121010000_brick_create_request_key`
188. `20261121100000_artifact_publish`
189. `20261121150000_computer_start_key`
190. `20261121200000_computer_late_told`
191. `20261122120000_computer_finish_intent`
192. `20261122140000_computer_start_ack`
193. `20261122220000_computer_ownership_and_start_attempts`
194. `20261123000000_computer_job_controls`
195. `20261123010000_computer_limit_pauses`
196. `20261123020000_computer_job_continues`
197. `20261123030000_computer_owner_lease_and_stretch`
198. `20261123040000_computer_commands_and_start_aliases`
199. `20261123050000_computer_park_hold_repair`
200. `20261123060000_computer_round8_fences`
201. `20261123070000_computer_round8_stretch_check`
202. `20261123080000_computer_round8_stretch_check_validate`
203. `20261124000000_computer_round9_columns`
204. `20261124100000_computer_power_ops`
205. `20261125000000_computer_mark_in_orbit`
206. `20261125100000_computer_take_over_check`
207. `20261126000000_app_actions`
208. `20261126120000_tool_person_heading`
209. `20261126130000_app_action_choice_by_person`
210. `20261126140000_app_action_choice_by_person_scope`
<!-- migrations:end -->
