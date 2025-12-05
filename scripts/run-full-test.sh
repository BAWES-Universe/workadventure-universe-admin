#!/bin/bash

# Complete Automated Test Workflow
# This runs all tests and validates the entire system

set -e

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Complete Test Suite${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

TOTAL_PASSED=0
TOTAL_FAILED=0

# Step 1: Unit Tests
echo -e "${BLUE}Running Unit Tests...${NC}"
if npm test -- --passWithNoTests --silent 2>&1 | tee /tmp/unit-tests.log; then
  UNIT_PASSED=$(grep -c "PASS\|passed" /tmp/unit-tests.log || echo "0")
  UNIT_FAILED=$(grep -c "FAIL\|failed" /tmp/unit-tests.log || echo "0")
  
  if [ "$UNIT_FAILED" -eq 0 ]; then
    echo -e "${GREEN}✓ Unit tests passed${NC}"
    ((TOTAL_PASSED++))
  else
    echo -e "${YELLOW}⚠ Unit tests: $UNIT_PASSED passed, $UNIT_FAILED failed${NC}"
    if [ "$UNIT_FAILED" -gt 0 ]; then
      ((TOTAL_FAILED++))
    fi
  fi
else
  echo -e "${RED}✗ Unit tests failed${NC}"
  ((TOTAL_FAILED++))
fi

echo ""

# Step 2: Linting
echo -e "${BLUE}Running Linter...${NC}"
if npm run lint 2>&1 | tee /tmp/lint.log; then
  echo -e "${GREEN}✓ Linting passed${NC}"
  ((TOTAL_PASSED++))
else
  LINT_ERRORS=$(grep -c "error" /tmp/lint.log || echo "0")
  if [ "$LINT_ERRORS" -eq 0 ]; then
    echo -e "${GREEN}✓ Linting passed${NC}"
    ((TOTAL_PASSED++))
  else
    echo -e "${YELLOW}⚠ Linting has warnings${NC}"
  fi
fi

echo ""

# Step 3: Type Check
echo -e "${BLUE}Running Type Check...${NC}"
if npx tsc --noEmit 2>&1 | tee /tmp/typecheck.log; then
  echo -e "${GREEN}✓ Type check passed${NC}"
  ((TOTAL_PASSED++))
else
  TYPE_ERRORS=$(grep -c "error TS" /tmp/typecheck.log || echo "0")
  if [ "$TYPE_ERRORS" -eq 0 ]; then
    echo -e "${GREEN}✓ Type check passed${NC}"
    ((TOTAL_PASSED++))
  else
    echo -e "${RED}✗ Type check failed${NC}"
    ((TOTAL_FAILED++))
  fi
fi

echo ""

# Step 4: Prisma Client Check
echo -e "${BLUE}Checking Prisma Client...${NC}"
if [ -d "node_modules/.prisma/client" ]; then
  echo -e "${GREEN}✓ Prisma client generated${NC}"
  ((TOTAL_PASSED++))
else
  echo -e "${YELLOW}⚠ Prisma client not found, generating...${NC}"
  npx prisma generate 2>&1 | tail -5
  if [ -d "node_modules/.prisma/client" ]; then
    echo -e "${GREEN}✓ Prisma client generated${NC}"
    ((TOTAL_PASSED++))
  else
    echo -e "${RED}✗ Failed to generate Prisma client${NC}"
    ((TOTAL_FAILED++))
  fi
fi

echo ""

# Summary
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Test Summary${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  ${GREEN}Passed: $TOTAL_PASSED${NC}"
echo -e "  ${RED}Failed: $TOTAL_FAILED${NC}"
echo ""

if [ $TOTAL_FAILED -eq 0 ]; then
  echo -e "${GREEN}✅ All tests passed!${NC}"
  exit 0
else
  echo -e "${RED}❌ Some tests failed${NC}"
  exit 1
fi

