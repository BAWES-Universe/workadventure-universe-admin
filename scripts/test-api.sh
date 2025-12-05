#!/bin/bash

# API Test Suite
# Tests all API endpoints to ensure they function correctly

set -e

BASE_URL="${BASE_URL:-http://localhost:3333}"
ADMIN_TOKEN="${ADMIN_API_TOKEN:-test-admin-token}"

echo "🧪 Testing WorkAdventure Admin API"
echo "Base URL: $BASE_URL"
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test counter
PASSED=0
FAILED=0

test_endpoint() {
  local name=$1
  local method=$2
  local url=$3
  local data=$4
  local expected_status=$5
  
  expected_status=${expected_status:-200}
  
  echo -n "Testing: $name ... "
  
  if [ "$method" = "GET" ]; then
    response=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $ADMIN_TOKEN" "$url" 2>/dev/null || echo -e "\n000")
  else
    response=$(curl -s -w "\n%{http_code}" -X "$method" -H "Authorization: Bearer $ADMIN_TOKEN" \
      -H "Content-Type: application/json" -d "$data" "$url" 2>/dev/null || echo -e "\n000")
  fi
  
  http_code=$(echo "$response" | tail -n1)
  body=$(echo "$response" | sed '$d')
  
  if [ "$http_code" = "$expected_status" ]; then
    echo -e "${GREEN}✓${NC} (HTTP $http_code)"
    ((PASSED++))
    return 0
  else
    echo -e "${RED}✗${NC} (Expected $expected_status, got $http_code)"
    echo "  Response: $body"
    ((FAILED++))
    return 1
  fi
}

# Test capabilities endpoint
test_endpoint "Capabilities" "GET" "$BASE_URL/api/capabilities"

# Test admin universes endpoints
test_endpoint "List Universes" "GET" "$BASE_URL/api/admin/universes"

# Test admin worlds endpoints
test_endpoint "List Worlds" "GET" "$BASE_URL/api/admin/worlds"

# Test admin rooms endpoints
test_endpoint "List Rooms" "GET" "$BASE_URL/api/admin/rooms"

# Test admin users endpoints
test_endpoint "List Users" "GET" "$BASE_URL/api/admin/users"

# Test auth endpoints (should fail without token, which is expected)
echo -n "Testing: Auth Login (no token) ... "
response=$(curl -s -w "\n%{http_code}" -X POST -H "Content-Type: application/json" \
  -d '{"accessToken":""}' "$BASE_URL/api/auth/login" 2>/dev/null || echo -e "\n000")
http_code=$(echo "$response" | tail -n1)
if [ "$http_code" = "400" ] || [ "$http_code" = "401" ]; then
  echo -e "${GREEN}✓${NC} (HTTP $http_code - expected)"
  ((PASSED++))
else
  echo -e "${RED}✗${NC} (Expected 400/401, got $http_code)"
  ((FAILED++))
fi

# Summary
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test Results:"
echo -e "  ${GREEN}Passed: $PASSED${NC}"
echo -e "  ${RED}Failed: $FAILED${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ $FAILED -eq 0 ]; then
  echo -e "${GREEN}All tests passed!${NC}"
  exit 0
else
  echo -e "${RED}Some tests failed${NC}"
  exit 1
fi

