const { Resend } = require('resend');

// Rate limiting configuration
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour
const MAX_REQUESTS_PER_WINDOW = 3; // Reduced from 5 for better security
const ipRequestMap = new Map();

// Cleanup old rate limit entries every hour
setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of ipRequestMap.entries()) {
        if (now - data.startTime > RATE_LIMIT_WINDOW) {
            ipRequestMap.delete(ip);
        }
    }
}, RATE_LIMIT_WINDOW);

exports.handler = async (event, context) => {
    // Enable CORS - Allow both www and non-www domains
    const origin = event.headers.origin || event.headers.Origin;
    const allowedOrigins = ['https://ibuildwith.ai', 'https://www.ibuildwith.ai'];
    const corsOrigin = allowedOrigins.includes(origin) ? origin : 'https://ibuildwith.ai';

    const headers = {
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
    };

    // Handle preflight OPTIONS request
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers,
            body: ''
        };
    }

    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: 'Method Not Allowed' })
        };
    }

    // Check for trusted API key (e.g., VAPI voice agent)
    const apiKey = event.headers['x-api-key'];
    const isTrustedCaller = apiKey && apiKey === process.env.VAPI_API_KEY;

    // Rate Limiting (skip for trusted callers)
    const clientIp = event.headers['client-ip'] || event.headers['x-forwarded-for'] || 'unknown';
    const now = Date.now();

    if (!isTrustedCaller && clientIp !== 'unknown') {
        const requestData = ipRequestMap.get(clientIp) || { count: 0, startTime: now };

        if (now - requestData.startTime > RATE_LIMIT_WINDOW) {
            // Reset window
            requestData.count = 1;
            requestData.startTime = now;
        } else {
            requestData.count++;
        }

        ipRequestMap.set(clientIp, requestData);

        if (requestData.count > MAX_REQUESTS_PER_WINDOW) {
            return {
                statusCode: 429,
                headers,
                body: JSON.stringify({ error: 'Too many requests. Please try again later.' })
            };
        }
    }

    try {
        const data = JSON.parse(event.body);
        const { firstName, lastName, email } = data;

        // Basic Validation
        if (!firstName || !lastName || !email) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Missing required fields' })
            };
        }

        // Email Validation - requires valid TLD (min 2 characters)
        const emailRegex = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
        if (!emailRegex.test(email)) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Invalid email format' })
            };
        }

        // 1. Add to Sender.net and track status
        let senderStatus = 'success';
        let senderErrorDetails = '';

        if (process.env.SENDER_API_TOKEN) {
            try {
                const addSubscriberResponse = await fetch('https://api.sender.net/v2/subscribers', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${process.env.SENDER_API_TOKEN}`,
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    body: JSON.stringify({
                        email: email,
                        firstname: firstName,
                        lastname: lastName
                    }),
                    signal: AbortSignal.timeout(5000) // 5 second timeout
                });

                const subscriberData = await addSubscriberResponse.json();

                if (!addSubscriberResponse.ok) {
                    // Check if subscriber already exists
                    if (addSubscriberResponse.status === 422 ||
                        (subscriberData.message && subscriberData.message.includes('already exists'))) {
                        console.log(`Email ${email} is already subscribed to Sender.net.`);
                        senderStatus = 'already_exists';
                    } else {
                        senderStatus = 'failed';
                        senderErrorDetails = `Status: ${addSubscriberResponse.status}, Message: ${subscriberData.message || addSubscriberResponse.statusText}`;
                        throw new Error(`Sender.net API error: ${subscriberData.message || addSubscriberResponse.statusText}`);
                    }
                } else {
                    console.log(`Successfully added ${email} to Sender.net`);
                    senderStatus = 'success';
                }
            } catch (senderError) {
                console.error('Sender.net Error:', senderError);
                senderStatus = 'failed';
                if (!senderErrorDetails) {
                    senderErrorDetails = senderError.message;
                }
            }
        } else {
            console.warn('Sender.net API token not set. Skipping Sender.net integration.');
            senderStatus = 'skipped';
        }

        // 2. Send Notification Email via Resend with Sender.net status
        try {
            const resend = new Resend(process.env.RESEND_API_KEY);

            let emailContent = `
      New Newsletter Signup:

      First Name: ${firstName}
      Last Name: ${lastName}
      Email: ${email}

      Date: ${new Date().toLocaleString()}

      Sender.net Status: ${senderStatus}`;

            if (senderStatus === 'failed') {
                emailContent += `

      ⚠️ ACTION REQUIRED: Failed to add subscriber to Sender.net
      Please manually add this subscriber to your Sender.net list.

      Error Details: ${senderErrorDetails}`;
            } else if (senderStatus === 'already_exists') {
                emailContent += `

      Note: This email already exists in Sender.net.`;
            }

            await resend.emails.send({
                from: 'contact@send.ibuildwith.ai',
                to: process.env.RECIPIENT_EMAIL,
                subject: senderStatus === 'failed'
                    ? `⚠️ Newsletter Signup - MANUAL ADD REQUIRED - ${firstName} ${lastName}`
                    : `New Newsletter Signup from ${firstName} ${lastName}`,
                text: emailContent,
            });
        } catch (resendError) {
            console.error('Resend notification email error:', resendError);
            // Don't fail the request if notification email fails
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ success: true, message: 'Successfully subscribed' })
        };

    } catch (error) {
        console.error('Error processing newsletter signup:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Internal Server Error' })
        };
    }
};
