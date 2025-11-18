# iBuildWith.ai Backend

Backend services for iBuildWith.ai website.

## Services

### Contact Form Function
- **Endpoint**: `/.netlify/functions/contact-form`
- **Method**: POST
- **Purpose**: Handles contact form submissions and sends emails via Resend

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Set up environment variables:
   ```bash
   cp .env.example .env
   # Edit .env with your actual values
   ```

3. Deploy to Netlify:
   - Connect this repo to Netlify
   - Set environment variables in Netlify dashboard
   - Deploy

## Environment Variables

Required in Netlify dashboard:
- `RESEND_API_KEY`: Your Resend API key
- `RECIPIENT_EMAIL`: Email address to receive form submissions

## CORS Configuration

The function accepts requests from:
- https://www.ibuildwith.ai
- https://next.ibuildwith.ai
- https://ibuildwith.ai

## Rate Limiting

- Max 5 submissions per IP per hour
- Resets on function cold start

more to come.