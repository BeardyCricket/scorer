# Deploying the SumUp → Supabase webhook

## Step 1 — Create the database table
1. Go to: https://supabase.com/dashboard/project/gdhqqcqzshvomnyfhsya/sql/new
2. Paste the contents of `match_signups_table.sql`
3. Click Run

## Step 2 — Install the Supabase CLI (one-time)
Open Terminal and run:
```
brew install supabase/tap/supabase
```

## Step 3 — Log in and link the project
```
supabase login
supabase link --project-ref gdhqqcqzshvomnyfhsya
```
(It will ask you to confirm in the browser — just click Allow)

## Step 4 — Deploy the Edge Function
From the scorer-main folder:
```
cd /Users/tomretter/Downloads/scorer-main
supabase functions deploy sumup-webhook --no-verify-jwt
```
The `--no-verify-jwt` flag is needed because SumUp sends unauthenticated POST requests.

Your webhook URL will be:
```
https://gdhqqcqzshvomnyfhsya.supabase.co/functions/v1/sumup-webhook
```

## Step 5 — Add the webhook in SumUp
1. Go to SumUp Developer Portal → Webhooks (or your SumUp dashboard → Settings → Webhooks)
2. Add a new webhook pointing to the URL above
3. Trigger event: Successful payment / Checkout completed
4. Save

## Step 6 — Test it
Make a test purchase (or use SumUp's webhook test tool if available).
Then check the logs:
```
supabase functions logs sumup-webhook
```
And check the table:
https://supabase.com/dashboard/project/gdhqqcqzshvomnyfhsya/editor (match_signups table)

## What to look for in the logs
The function logs the full raw payload from SumUp on the very first call.
If the field names don't match (e.g. email is in a different place), share the log output
and the code can be updated to match.
