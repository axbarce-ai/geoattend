# What changed in this update

This update replaces last session's anomaly-verification approach with a
different one, per updated instructions: verification now happens
automatically on the EMPLOYEE'S OWN mobile device, not at Admin.

1. **Anomaly-flagged attendance now triggers automatic, on-device Face
   Verification on the mobile app — never an admin action.**
   - Found and fixed a real bug first: `controllers/attendanceController.js`
     `faceVerify()` (the endpoint the employee's own re-verification hits)
     was accepting *any* uploaded selfie unconditionally and marking
     attendance "Verified" with no actual face matching — it could never
     fail. It now runs a real 1:1 match against the employee's own
     enrolled face(s) using the same InsightFace pipeline and threshold
     used everywhere else in the app, and requires the same liveness check
     (hold steady, then blink) used at registration. Only a genuine match
     confirms attendance; a wrong face, no face detected, or a skipped
     liveness check all fail cleanly and leave the record exactly as
     flagged as it was.
   - **Tested with real face photos** against the actual InsightFace models
     already in this project's `models/` folder: a matching photo correctly
     confirms attendance and resolves the anomaly; a mismatched photo
     (tested against a random reference embedding, standing in for a
     genuinely different person) correctly fails and leaves the record
     unconfirmed; missing liveness, a missing photo, and someone
     submitting another employee's attendance ID are all correctly
     rejected before any face processing happens.
   - New mobile screen `mobile/src/screens/FaceVerificationScreen.js`:
     auto-starts the camera and the same hold-steady-then-blink liveness
     check RegistrationScreen.js uses (duplicated intentionally, not
     shared, so a future change to one can't silently change the other),
     captures a photo, and uploads it. Success confirms the attendance;
     failure offers Try Again and does not confirm anything.
   - `mobile/src/context/AttendanceTrackingContext.js`: the moment a
     time-in comes back flagged (`requiresFaceVerification`), the app
     navigates straight to FaceVerificationScreen — via a new
     `mobile/src/navigation/navigationRef.js`, since this has to happen
     from a background location callback, not a button press. Backing out
     without completing it does not confirm the attendance either; the
     next meaningful history refresh (app resume, or a session
     auto-ending) brings the screen back up rather than leaving it
     silently unconfirmed.
   - Admin visibility: `views/dashboard.ejs` / `public/js/app.js` — the
     Verification section's and Geo-Fences page's anomaly panels are now
     **read-only monitoring displays** ("N flagged attendance records
     awaiting the employee's own on-device verification"), with no
     "verify it yourself" buttons — last session's admin-performs-the-
     verification workflow was removed. The admin Attendance table already
     showed selfie/verification status per record (`faceVerificationCell`)
     and needed no changes. A leftover backend bypass endpoint
     (`PATCH /attendance/anomalies/:id/resolve`) is no longer called from
     the UI; it's documented in place as unused, since it only ever
     touched the anomaly record and never actually confirmed the
     underlying attendance, which could have left the two out of sync.

## Before running

No database migration. No new packages for the backend or admin dashboard.

Face Verification needs the InsightFace models in `models/`
(`det_10g.onnx` + `w600k_r50.onnx`) to actually run — your project already
has both (confirmed while testing this update: same files, byte-for-byte),
so there's nothing to set up. This was mentioned only because this is the
first update where that model actually gets exercised for something new
(the automatic on-device re-verification below) rather than just the
existing admin Face Verification tool.

---

# Previous update (kept for reference)

1. **Mobile Device Registration — every field required except Middle Name
   and Suffix.**
   - `RegistrationScreen.js` and `controllers/employeeAuthController.js`
     (`link-device`): Department, Position, and Gender are now required,
     enforced on both the form and the API (so a direct API call can't
     bypass what the form enforces). Middle Name and Suffix stay optional.

2. **Admin can now genuinely verify a flagged/anomalous attendance record
   via OCR or Face Verification.**
   - The underlying pieces already existed (geo-anomaly detection,
     `recordVerificationAttendance()`'s "anomaly_resolved" handling, the
     OCR/Face capture tools themselves) but were never connected end to
     end: there was no way for an admin to see *which* attendance was
     flagged before going to verify it, and the one place flags were shown
     (the Geo-Fences page) had only a "Mark Resolved" button that skipped
     any actual identity check.
   - `views/dashboard.ejs` / `public/js/app.js`: added a "Flagged
     Attendance Awaiting Verification" panel at the top of the Verification
     section, listing each flagged record with the employee, event, and
     why it was flagged. "Verify via Face" / "Verify via OCR" jumps to that
     tab, pre-selects the flagged event in the capture dropdown, and shows
     a "Now verifying X for Y" reminder banner. Resolving the flag is a
     side effect of a successful match, same as before — there's no
     separate "just mark it resolved" action in this panel by design.
   - The Geo-Fences page's own alert panel now leads with "Verify
     Identity" (routing into the same flow) instead of a bare resolve
     button; the old bypass is kept only as a clearly-labeled secondary
     "Dismiss without verifying" option for genuine false alarms.

3. **Mobile UI: logo + app name in the upper-left corner, applied
   consistently.**
   - New `mobile/src/components/AppHeader.js`: the CSPC seal (the same
     image already used on the Login screen) in a small badge next to the
     "GeoAttend" wordmark, mirroring the admin web dashboard's own sidebar
     header treatment. Falls back to a plain icon badge if the remote logo
     image can't load, so branding never just disappears.
   - Added to the top of Dashboard, Attendance, Attendance Logs (History),
     and Profile — the four main screens an employee actually navigates
     between — giving every screen the same consistent header instead of
     each styling its own title independently.
   - Audited screen layouts for anything that could overflow a narrow,
     tall-aspect-ratio phone (~76mm / 360dp wide): no hardcoded oversized
     dimensions were found: the app already uses flexible/relative sizing
     throughout, and the one intentionally fixed-size element (the
     face-scan guide oval, ~242px) comfortably fits within that width.

4. **Mobile Profile — shows the employee's actual registration photo.**
   - `controllers/employeeAuthController.js`: employee login/registration
     responses now include `face_photo_url`, the most recent photo from
     `employee_faces` (an employee can register more than once; "most
     recent" is what actually represents how they look now).
   - `ProfileScreen.js`: displays that photo in the avatar circle, with a
     graceful fallback to the placeholder icon if there's no photo on file
     or it fails to load.

5. **Mark Attendance — confirmed already correctly scoped, no change
   needed.** Read through `AttendanceScreen.js`, `BottomNav.js`, and
   `DashboardScreen.js` in full: there is no event list anywhere in the
   attendance-marking flow. `AttendanceScreen` only ever shows the single
   event passed to it via `geofenceId`, and the only ways to reach it are
   tapping a specific event in Today's Schedule or the current
   active-event quick action — both already scope to exactly one event.

6. **Admin Device Management → Registered Devices, relabeled.**
   - `views/dashboard.ejs` / `public/js/app.js`: the device detail view now
     shows a clearly labeled "ID Number" field with "Department" directly
     underneath it, followed by Position/Classification/Remark/Email.
     Phone and Employment Status were removed. "MAC Address" is replaced
     with "Device ID", showing the device's actual `device_uid` (the real
     unique identifier — MAC address is rarely even populated, since modern
     Android/iOS restrict raw MAC access). The main device table's column
     was updated the same way.

7. **Admin Employees — Classification and Remark cleaned up.**
   - The Classification dropdown's "Legacy" Regular/COS/Casual options are
     gone — only the six current values remain (Permanent Administrative,
     Permanent Academic, Casual Administrative, COS Administrative, COS
     Academic, Job Order), the same list already used on the mobile
     registration form.
   - Remark is now just Active / On Leave (was Active/Inactive/Leave).
   - `database/migration_v17_classification_remark_cleanup.sql`:
     reassigns every employee still on an old value before removing it
     from the dropdowns, so nobody is left unselectable. 'Casual' →
     'Casual Administrative' (unambiguous). 'COS'/'Regular' → their
     Academic or Administrative counterpart, guessed from the employee's
     Position title (e.g. "Instructor I" → Academic, "Administrative Aide
     III" → Administrative) — a best-effort heuristic, not a guarantee;
     the migration prints a review list of everyone it guessed for.
     'Inactive'/'Leave' remarks both become 'On Leave' (an employee no
     longer with the institution belongs in the Status field, not here) —
     this doesn't change any attendance-expectation logic, since
     everywhere that reads this column already only ever checks
     `remark = 'Active'`.

## Before running

Run the new migration once against your existing database, and read
through the printed review list afterward (a handful of employees may
have been guessed as Academic when they're actually Administrative, or
vice versa — correct any from the Employees tab like any other edit):

```bash
mysql -u <user> -p geoattend_pro < database/migration_v17_classification_remark_cleanup.sql
```

No new packages.

---

# Previous update (kept for reference)

1. **Mobile Device Registration — Position and Gender are now dropdowns,
   and Classification uses a new fixed option list. All three have an
   "Others" option that reveals a free-text field for anything not
   listed.**
   - `mobile/src/screens/RegistrationScreen.js`: added a reusable
     `DropdownFieldWithOthers` component (picker + built-in "Others"
     free-text override) and used it for all three fields.
   - **Classification** options: Permanent Administrative, Permanent
     Academic, Casual Administrative, COS Administrative, COS Academic,
     Job Order, plus Others. Now required (previously always had a default
     of "Regular"; there's no longer an obvious default among the new
     values, so the employee must actively choose one).
   - **Gender** is a brand new field (Male, Female, Others) -- it didn't
     exist anywhere before this update. Optional, matching Position.
   - **Position** changed from free text to a dropdown with a starter list
     of common CSPC academic/administrative titles (Instructor I-III,
     Assistant/Associate Professor, Professor, Department Dean, Program
     Chair, Registrar Staff, Administrative Aide I-III,
     etc.), plus Others -- adjust `POSITION_OPTIONS` in
     `RegistrationScreen.js` if this list should look different.
   - A returning employee's existing value for any of these three fields
     is never silently dropped: if it matches one of the picker's options
     it's pre-selected normally; if it's a legacy value or something
     previously typed into "Others", "Others" is pre-selected with that
     exact value already filled in (`resolveDropdownValue()`).
   - Picking "Others" without filling in the free-text field is caught
     before the employee can continue to face registration ("Please
     specify your Position/Gender/Classification, or choose one from the
     list.").

2. **Database changes behind the above.**
   - `employees.gender` is a new nullable column.
   - `employees.classification` was `ENUM('Regular','COS','Casual')` --
     widened to `VARCHAR(50)`, since an ENUM can only ever hold one of its
     declared values and can't represent the new option list or anything
     typed into "Others". Every existing `Regular`/`COS`/`Casual` value is
     preserved exactly as-is; nothing is renamed or reset.
   - `database/migration_v16_position_gender_classification.sql` applies
     both changes to an existing database. Safe to re-run.

3. **Backend validation relaxed to match (`controllers/employeeAuthController.js`,
   `controllers/employeeController.js`).**
   - Classification is no longer checked against a fixed whitelist (it
     used to reject anything except Regular/Casual on the mobile endpoint,
     or Regular/COS/Casual on the admin endpoint) -- since "Others" must
     accept arbitrary text, both endpoints now just require it to be
     present and 50 characters or fewer, the same way `position` already
     had no whitelist.
   - The old mobile-registration rule that specially preserved an existing
     employee's COS classification (because the old picker could only ever
     submit Regular or Casual, so blindly overwriting would have
     downgraded them) was removed -- the new picker can represent any
     classification directly, including COS Administrative/COS Academic,
     so there's no longer a value this form structurally can't re-select.

4. **Admin dashboard — Classification dropdown widened, to prevent data
   loss (not an explicitly requested change, but required by the above).**
   - `views/dashboard.ejs`'s Employees "Edit" form had a Classification
     `<select>` with only the old 3 options. Left as-is, opening the edit
     form for an employee whose classification came from the new mobile
     flow would show nothing selected, and saving the form (even without
     touching that field) would have silently overwritten their real
     classification. The dropdown now lists both the new 6 options and the
     legacy 3.
   - `public/js/app.js`: added `setSelectPreservingUnknown()` as an extra
     safeguard for the residual case a dropdown can never fully cover on
     its own -- a fully custom value someone typed into mobile's "Others".
     If an employee's actual classification doesn't match any listed
     option, a temporary option for that exact value is inserted so it's
     visible and preserved instead of silently lost.
   - The Dashboard's Regular/COS/Casual breakdown chart was intentionally
     left as-is (out of scope for this request) -- an employee whose
     classification is one of the 6 new values just won't be counted in
     that specific chart. Worth revisiting separately if that chart should
     reflect the new categories too.

## Before running

Run the migration once against your existing database:

```bash
mysql -u <user> -p geoattend_pro < database/migration_v16_position_gender_classification.sql
```

No new packages.

---

# Previous update (kept for reference)

1. **Bug fix — "Data should not be empty or the 'fields' option should be
   included" crash when downloading a CSV/Excel report for a filter with
   zero matching records.**
   - Root cause: `controllers/reportController.js` `exportReport()` handed
     the query results straight to `json2csv`'s `Parser` with no `fields`
     option, relying on it to infer the column headers from the shape of
     the first row. That inference has nothing to work from when the query
     matches zero attendance rows (e.g. a month/department/employee/event
     combination with no records) -- json2csv's `Parser().parse([])`
     throws exactly this error instead of producing an (empty) file, which
     crashed the whole export request.
   - Fix: both the CSV and Excel writers now use an explicit
     `REPORT_EXPORT_FIELDS` column list (`Date`, `Employee`, `Employee ID`,
     `Department`, `Status`, `Late Minutes` -- the same columns as before,
     Work Hours still excluded per the previous update) instead of
     inferring columns from the data. A filter with no matches now
     downloads a valid file containing just the header row, instead of a
     500 error.
   - This also fixes a related, less visible gap in the Excel path: before
     this fix, a zero-row export's `sheet.columns` was never set at all
     (the code only set it `if (rows.length > 0)`), so the downloaded
     workbook had no header row whatsoever -- it just looked broken/blank
     rather than "no records for this filter". It's now always set, and
     the header row is always bold, whether or not there's data beneath it.

## Before running

No new packages, no database migration.

---

# Previous update (kept for reference)

1. **Bug fix — "Audit log write failed: ... foreign key constraint fails
   ... admin_id ... REFERENCES admin_accounts".**
   - Root cause: `middleware/authMiddleware.js`'s `requireAuth` only
     verified the JWT's *signature*, then trusted whatever admin `id`/`role`
     was baked into it for the token's entire lifetime (up to 30 days with
     "remember me"). It never re-checked that the admin account still
     existed. So if an admin account was deleted (or deactivated) while
     that admin still had a valid, unexpired session, every write action
     they took afterward still went through — right up until it tried to
     record itself in `audit_logs` (`services/auditService.js`
     `logAction()`, called with that admin's now-nonexistent id), which
     MySQL correctly rejected as a foreign-key violation. The error shown
     was that rejection, not a database or schema problem.
   - Fix: `requireAuth` now looks up the admin by the token's `id` on every
     request and rejects with 401 ("Your account is no longer active...")
     if the row is gone or `is_active = 0`, before the request can reach
     any controller. This closes the actual gap — a deleted/deactivated
     admin's session stops working immediately — not just the audit-log
     symptom. As a side effect, `req.admin.role` is now also read fresh
     from the database on every request rather than from the token, so a
     role change (e.g. demoted from super_admin) takes effect on that
     admin's very next request instead of only once their current session
     expires.
   - `services/auditService.js` `logAction()`: added a defense-in-depth
     fallback for the one case the above check can't fully close — a
     genuine race where the admin's account is deleted by someone else in
     the moment between that check and the `audit_logs` INSERT. Instead of
     losing the log entry (previous behavior: caught, logged to the
     console, and dropped), it retries once with `admin_id = NULL` (the
     column is nullable — the same value an existing row gets automatically
     via `ON DELETE SET NULL` if its admin is deleted later), so the action
     itself is still recorded.
   - No schema or route changes; every existing `logAction()` call site
     already sourced `adminId` from `req.admin.id` post-`requireAuth`, so
     this one fix covers all of them uniformly.

## Before running

No new packages, no database migration.

---

# Previous update (kept for reference)

1. **Bug fix — "Confirmation recording failed" / "Recording was stopped
   before any data could be produced" during mobile face registration.**
   - `mobile/src/screens/RegistrationScreen.js`: removed the brief
     confirmation-video recording step (`recordAsync()` /
     `stopRecording()`) that ran right after the hold + blink checks
     passed. That pairing has a known race in expo-camera where stopping
     very soon after starting can reject with exactly this error, which
     Expo's dev-mode LogBox then surfaces as a blocking "Console Warning"
     overlay.
   - This was safe to remove outright: the video was never required by the
     backend (`employeeAuthController.linkDevice()` only requires the still
     `image`) and was never surfaced anywhere in the admin dashboard
     (`video_path` was stored but never read back by any query or UI).
     Removing it also makes the automatic capture noticeably faster (no
     more multi-second recording detour).
   - `controllers/employeeAuthController.js` and `routes/employeeAuthRoutes.js`:
     comments updated to reflect that `video` is now an optional,
     unused-by-the-current-client field kept only for backward
     compatibility — no schema or validation changes.
   - UI wording: "Retake Video Selfie" → "Retake Photo"; the "RECORDING"
     badge (shown for the instant the final photo is taken) → "CAPTURING",
     since nothing is actually being recorded anymore.

2. **Mobile — fully automatic capture (Face Detection → Blink Detection →
   Automatic Capture, no button).**
   This was already the structure from the previous update (there was never
   a separate manual "Capture" button — `handleStartGuidedCapture` already
   ran hold-detection then blink-detection then captured automatically) but
   the video-recording bug fixed above was sitting directly in the middle
   of that automatic sequence, so this update is what makes the fully
   automatic flow actually reliable rather than erroring partway through.

3. **Admin Reports — Work Hours removed from CSV and Excel downloads.**
   - `controllers/reportController.js` `exportReport()`: dropped
     `a.work_hours AS 'Work Hours'` from the export query. Both the CSV
     (json2csv) and Excel (ExcelJS) writers build their columns directly
     from this query's result keys, so removing it here removes it from
     both downloaded formats at once — no separate column list to keep in
     sync. The on-screen report preview never showed a Work Hours column
     either, so nothing else changed.

4. **Admin Device Management — View button showing the employee and their
   registration photo.**
   - Each device row now has a "View" (eye icon) button. It opens a modal
     with the employee's photo captured **during that specific device's
     registration**, plus their profile details (position, classification,
     employment status, remark, email, phone) and the device's own details
     (model, brand, OS, MAC address, registered date, status), with
     Approve/Blacklist actions available right there.
   - `controllers/deviceController.js` `getDevices()`: an employee can
     register more than once (each attempt/device inserts its own
     `employee_faces` row — see FACE_VERIFICATION_README.md's "Known gaps"
     note), so each device is matched to the `employee_faces` row whose
     `created_at` is *closest in time* to that device's own `registered_at`
     (a window-function query), not just "the employee's newest photo" —
     otherwise an admin reviewing an older, still-pending device could be
     shown a completely different, more recent photo instead of the one
     actually taken when that device was registered.
   - A device with no `employee_faces` row on file (registered through some
     other path, or the photo was somehow never saved) shows a "No Photo"
     placeholder — a self-contained inline SVG, not a broken-image icon or
     a request to a missing file.
   - `views/dashboard.ejs` / `public/js/app.js`: new modal markup and
     `G_App.mobile.openViewModal()` / `closeViewModal()`.

## Before running

No new packages, no database migration. `employee_faces.video_path` and the
`video` upload field are unaffected (still accepted, just no longer sent by
the current mobile app).

---

# Previous update (kept for reference)

1. **Mobile — blink required during face registration.**
   - `mobile/src/screens/RegistrationScreen.js`: after the existing "hold
     your face steady" check passes, the employee is now prompted to
     **blink**. A new `detectBlink()` step waits for a genuine
     eyes-open → eyes-closed → eyes-open cycle, read from ML Kit's per-eye
     "open probability" classification (`classificationMode: 'all'`), within
     an 8-second window. A still photo or a paused video frame held up to
     the camera can hold still, but its eye-open reading never moves, so it
     can never complete that cycle.
   - UI: caption changes to "Blink your eyes" then "Great — now open your
     eyes", with an eye / eye-off icon; a distinct error message
     ("Couldn't confirm a blink...") shows when the blink specifically is
     what failed, separate from the existing "couldn't detect your face"
     message.
   - `FACE_VERIFICATION_README.md`'s stale "No liveness detection" line
     (already out of date before this change — a hold-steady check existed)
     is corrected to describe the hold + blink liveness check that's
     actually there now.

2. **Mobile — Wi-Fi off/disconnected notification.**
   - New `mobile/src/context/WifiStatusContext.js` and
     `mobile/src/components/WifiGateOverlay.js`, mirroring the app's
     existing GPS pattern exactly (`LocationStatusContext` /
     `LocationGateOverlay`). Polls whether Wi-Fi is on and joined to a
     network (Android: `WifiManager.isEnabled()` +
     `connectionStatus()`; iOS: `getCurrentWifiSSID()`, the closest signal
     Apple allows).
   - Shows **"Please turn on your Wi-Fi."** app-wide, blocking every screen,
     for as long as the employee is signed in and Wi-Fi is off or
     disconnected — the same treatment GPS already gets. If GPS is also off,
     the existing GPS overlay is left to handle that alone rather than
     stacking two blocking screens.
   - The equivalent Location notification the request also asked for
     already existed in the app (`LocationGateOverlay`, "Please turn on your
     Location/GPS.") — no change needed there.
   - Wired into `mobile/App.js` alongside the existing Location provider/overlay.

3. **Admin Ratings — per-employee event list, and corrected Total
   Rating / Rating Points formula.**
   - `controllers/ratingController.js` `getRatings()`: **Total Rating** is
     now the **sum** of an employee's own ratings across the month's
     applicable events (it was, confusingly, an average before). **Rating
     Points** is now Total Rating ÷ number of rated events. Matches the
     requested example exactly: present at 3 events rated 5 each → Total
     Rating 15, Rating Points 5; present twice and absent once (5, 5, 1) →
     Total Rating 11, Rating Points 3.67.
   - Each employee's row now also includes `rated_events`: their own list of
     events with a rating, each paired with that rating — the "listahan ng
     mga Events na pinasukan ng employee at ang rating niya sa bawat event".
   - This intentionally stops selecting the unrelated `employees.rating_points`
     column (an older, separate "5 attendances = 1 point" counter used
     elsewhere in the dashboard, written by
     `attendanceController.recalculateRatingPoints()`) so this endpoint's
     own `rating_points` field can carry the newly-requested meaning without
     colliding with it. That older column and its call sites are untouched.
   - `views/dashboard.ejs` / `public/js/app.js`: the Ratings grid's Total
     Rating / Rating Points columns now show the corrected figures; a new
     **Events** button per employee row opens a modal listing their events
     (title, date, venue, Present/Absent badge with the 1-5 rating) plus a
     Total Rating / Rating Points summary. Disabled (greyed out) for an
     employee with no rated events that month.

## Before running

No new packages to install — `@react-native-ml-kit/face-detection` and
`react-native-wifi-reborn` were already mobile dependencies.

---

# Previous update in this session (kept for reference)

1. **Default email domain is now `@my.cspc.edu.ph` (`@geoattend.pro` removed).**
   - `config/config.js`: new `email` settings with the CSPC domain and the
     default admin email, `admin@my.cspc.edu.ph`. If an old `.env` still says
     `DEFAULT_ADMIN_EMAIL=admin@geoattend.pro`, it's rewritten to
     `@my.cspc.edu.ph` so the old domain can't come back.
   - `server.js`: now passes the default admin email to the login page. It
     never did before, so the login field always showed the hardcoded
     `admin@geoattend.pro` no matter what `.env` said.
   - `database/seed.js`: seeds `admin@my.cspc.edu.ph` and the sample
     employees on `@my.cspc.edu.ph`. Before that, it renames any existing
     `@geoattend.pro` admin accounts and employees instead of creating
     duplicates (passwords stay the same).
   - `database/migration_v15_cspc_email_domain.sql`: the same rename as plain
     SQL. Safe to re-run; an address is skipped if its `@my.cspc.edu.ph`
     version already exists.
   - `views/dashboard.ejs`: login default, the Add Admin placeholder
     (`admin@my.cspc.edu.ph`) and the Add Employee email hint.
   - `.env` and `README.md` updated.
   - Not changed on purpose: `com.geoattend.pro` in `mobile/app.json` is the
     app's package ID, not an email. Changing it would make phones treat the
     app as a different app.

2. **New: Attendance Insights by Office / College (Reports page).**
   After **Generate Analytical Report**, a new panel between the summary cards
   and the records table ranks every office and college by attendance at the
   events in scope: the selected event, or every event that has started in
   the selected Year/Month.
   - **Most attendance** lists offices from highest to lowest attendance
     (descending). **Minimum attendance** lists them from lowest to highest
     (ascending).
   - **Rank by** attendance rate (default, fair between small and large
     offices) or by number attended.
   - A summary line names the highest and lowest office and the overall rate.
   - Click an office to see the employees involved, sorted the same way. For
     one event: each person's status (Present / Late / Excused / Absent /
     No time-in) and time in/out. For several events: attended X of Y, rate,
     and what they missed. **Show all employees** opens every office.
   - The office picked in the Office/Dept filter is highlighted and opened.
   - Counting rules match the rest of the app:
     - Attended = Present or Late (same as the Dashboard department chart).
     - Expected = active employees of the event's department, or all active
       employees for a campus-wide event (same as Ratings).
     - An expected employee with no attendance row counts as "No time-in".
     - Someone on leave who still timed in is included.
     - Upcoming events aren't counted until they start.
   - API: `GET /api/reports/insights?year=&month=&event_id=&order=most|least&rank_by=rate|count`
     (`controllers/reportController.js` `getInsights`, `routes/reportRoutes.js`).
   - UI: `G_App.reports` in `public/js/app.js`, panel markup and styles in
     `views/dashboard.ejs`.
   - Before counting, the endpoint runs the same cleanup the Attendance tab
     already runs (`closeSessionsForEndedEvents`, now exported from
     `controllers/attendanceController.js`). Attendance left open after an
     event ended is settled first, so a few minutes' check-in becomes Absent
     instead of counting as Present.

3. **Reports filter fixes.**
   - Year now defaults to the current year. It was hardcoded to 2025, so a
     report for 2026 events came back empty unless the year was changed.
   - Picking a specific event sets Year and Month to that event's date.

## Before running

No new packages to install.

For an existing database, move the old accounts to the new domain once
(either command works), then log in with `admin@my.cspc.edu.ph` and your
existing password:

```bash
npm run seed
```

```bash
mysql -u <user> -p geoattend_pro < database/migration_v15_cspc_email_domain.sql
```

---

# Previous update (kept for reference)

1. **Fixed: face registration always erroring out.**
   The face-recognition recognizer model (`models/w600k_r50.onnx`, ~174MB)
   was missing from the repo — every face photo upload (register AND
   re-register) failed server-side with "Could not process the face photo."
   It's now bundled in `models/`. No code/config changes needed; verified
   end-to-end (detect → align → recognize) against a real sample photo.

2. **Simplified: face capture is now a single step everywhere.**
   Both the mobile registration flow (`mobile/src/screens/RegistrationScreen.js`)
   and the admin dashboard's "Live Selfie Verification" kiosk
   (`public/js/app.js` — `G_App.face`) used to require a 2-3 step guided
   sequence (nod / blink / turn head left / turn head right — random order,
   random subset), each individually verified live. Both are now a single
   "hold your face steady in frame" step — still verified live (mobile: via
   on-device ML Kit face detection; dashboard: via canvas skin-tone pixel
   analysis), just with one thing to get right instead of two or three. An
   empty frame or a photo of a photo still won't pass either flow.

3. **Fixed: attendance duration kept accumulating while offline AND outside
   the geofence.**
   Previously, ending an attendance session relied entirely on a heartbeat
   ping reaching the server (`POST /attendance/:id/heartbeat`) while the
   employee was outside the boundary. If the device had no connectivity
   (e.g. WiFi turned off) during that window, no ping could get through, so
   the session just stayed open — and once the employee came back in range
   and a ping finally succeeded, the server closed the session using "now,"
   crediting the ENTIRE offline gap (including the time spent outside) as
   attendance.
   - **Mobile** (`mobile/src/context/AttendanceTrackingContext.js`): GPS
     keeps working without connectivity, so the app now detects "I've left
     the geofence" locally (`LOCAL_OUTSIDE_CONFIRM_READINGS` consecutive
     readings), immediately freezes that session's displayed duration at the
     moment of exit (`pendingExitAt`, in `mobile/src/utils/duration.js`),
     and keeps retrying THAT exact captured reading/timestamp to the server
     (not a fresh "now" reading) until it's acknowledged — even if the
     device wanders back inside before connectivity returns.
   - **Backend** (`controllers/attendanceController.js` — `heartbeat`):
     accepts an optional `observed_at` field and, when present and sane (not
     from the future, not implausibly stale), closes the session using that
     timestamp instead of the moment the request happened to arrive.
   - **API client** (`mobile/src/api/client.js`): `sendHeartbeat` now
     forwards this timestamp.

4. **New: OCR Verification and Live Selfie Verification can now record
   attendance directly**, as an alternative to the mobile app's GPS
   check-in — for an employee who doesn't have their phone (use ID-card OCR
   instead) or doesn't have their ID on hand (use live selfie instead).
   - Both admin Verification panels (`views/dashboard.ejs` /
     `public/js/app.js`) now have a **"Record Attendance For"** event
     dropdown, populated from the new `GET /api/events/ongoing` endpoint
     (accessible to both `super_admin` and the restricted Verification-only
     `admin` role). Leave it on "Verify identity only" to keep the old
     identity-check-only behavior.
   - When an event is selected and the scan/selfie successfully matches an
     employee, `controllers/ocrController.js` / `controllers/faceController.js`
     call the new `recordVerificationAttendance()` in
     `controllers/attendanceController.js`, which behaves like tapping in/out
     at a physical kiosk: no open session today → time-in; already open →
     this same action closes it (time-out); already closed once today (event
     still running) → opens a fresh re-entry session. No GPS/geofence check
     runs here at all — the admin is physically confirming identity in
     person, which is the point of this fallback.
   - **Every attendance record now shows HOW it was captured.** New columns
     on `attendance` (`database/migration_v14.sql`): `verification_method`
     ('mobile_gps' / 'ocr' / 'face'), `face_record_id`, `verified_by_admin_id`.
     The admin Attendance table has a new **Method** column (Mobile GPS /
     ID Verification / Face Verification badge) showing this per row.

5. **New: app-wide Location/GPS enabled check.**
   After signing in, the mobile app now continuously checks whether the
   device's Location/GPS **service** is actually turned on (not just whether
   permission was granted — those are different things; an employee can
   grant permission once and then flip GPS off from quick-settings at any
   point). While it's off, a **"Please turn on your Location/GPS."** prompt
   covers every screen with no way to dismiss it except turning GPS back
   on — blocking every location-dependent feature (auto time-in/out
   tracking, the Attendance screen, WifiCheck's location-based Wi-Fi read)
   until it is. It clears itself automatically the moment GPS is detected
   on again, no manual "continue" needed.
   - New: `mobile/src/context/LocationStatusContext.js` (polls
     `Location.hasServicesEnabledAsync()`, plus an immediate recheck when the
     app returns to the foreground) and
     `mobile/src/components/LocationGateOverlay.js` (the blocking prompt,
     with a "Turn On Location" button — opens the system prompt directly on
     Android via `enableNetworkProviderAsync()`, or the Settings app on iOS).
   - `mobile/App.js`: both are mounted app-wide, above the navigation stack.
   - `mobile/src/context/AttendanceTrackingContext.js`: the auto
     time-in/out tracking loop itself now also requires GPS to be on
     (`trackingEnabled` factors in `locationEnabled`), so it stops the
     moment GPS goes off and resumes cleanly the moment it's back on — not
     just visually blocked by the overlay, but not running underneath it either.

## Before running

```bash
npm install                # backend
cd mobile && npm install   # mobile
```

Both `models/det_10g.onnx` and `models/w600k_r50.onnx` are already in place —
nothing to download.

Run the new migration against an existing database:
```bash
mysql -u <user> -p geoattend_pro < database/migration_v14.sql
```
(Fresh installs from `database/schema.sql` already include everything —
nothing extra to run.)
