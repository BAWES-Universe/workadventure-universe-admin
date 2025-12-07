# Getting OIDC token from WA

Execute the following script in dev console after login:

```
// Get the JWT token and extract the OIDC access token
(() => {
    const jwt = localStorage.getItem('authToken');
    if (!jwt) {
        console.log('No auth token found. Are you logged in?');
        return null;
    }
    const base64Url = jwt.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
        atob(base64)
            .split('')
            .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
            .join('')
    );
    const decoded = JSON.parse(jsonPayload);
    console.log('OIDC Access Token:', decoded.accessToken);
    console.log('Full JWT payload:', decoded);
    return decoded.accessToken;
})();
```